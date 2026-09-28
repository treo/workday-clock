/*
	paperd.ink classic work-day clock + pomodoro timer.

	Ported from the M5Paper app (960x540 touch, GC16/A2 updates) to the
	paperd.ink classic (paperd_classic: 400x300, 1 bpp panel, four buttons,
	no touch). What changed in the port:

	- Layout redesigned for 400x300; set in Pixel Operator (CC0, dafont.com),
		baked monochrome at 80/24/16 px -- a pixel font on a pixel panel, sharp
		at 1 bpp with no dithering tricks needed.
	- The panel is one bit per pixel and the app is text, so dithering is
	  disabled (screen.configure({dither:false})): gray skins would only
	  threshold to black or white anyway, so the palette is pure black/white.
	- The touch Start/Stop button is gone entirely -- an unpressable button is
		misleading. The hardware buttons drive it:
	 Button 1 (top)    start / stop the pomodoro
	 Button 2          refresh the todo pull (next best action) now
	   The pomodoro state lives in the status line (countdown / session count).
	- A piezo buzzer beeps at each phase change (work -> break, break -> work).
	- Countdown granularity is one minute. This panel needs ~1.2 s for a
	  partial update and every status tick would be a full-screen refresh, so
	  the status line shows whole minutes and the panel paints at most once a
	  minute (plus the fetch responses). A full (flashing) refresh re-converges
	  ghosting every FULL_REFRESH_EVERY painted frames.
	- device.peripheral.battery.read() returns millivolts here (3000..4300),
	  not the 0..1 fraction the M5Paper host returned.
	- The paperd.ink classic has no RTC peripheral; the clock comes from SNTP
	  at boot (setup/network), and the RTC path below is a no-op there.

	- Displays the current time in large type.
	- Between 8:00am and 5:00pm, displays the remaining work day as a series of
	  15 minute blocks; blocks disappear as each quarter hour elapses.
	- A pomodoro timer (25 minutes of work, 5 minutes of break) can be started
	  and stopped with button 1. While running, it counts down in the status
	  line and cycles work -> break -> work until stopped.
	- A card shows the next best action reported by the task linearizer
	  (GET http://<host>:<port>/api/today), refreshed every 10 minutes, or on
	  demand with button 2.

	Build & run (simulator):
		mcconfig -d -m -p sim/paperd_classic

	For unattended runs, or to test the work-day blocks, pass a simulated
	start time (milliseconds since the epoch) with the manifest config:
		mcconfig -d -m -p sim/paperd_classic now=1789653600000
	The pomodoro durations can be overridden the same way: workMs=..., breakMs=...
	The linearizer endpoint can be overridden the same way:
	linearizerHost=..., linearizerPort=..., linearizerPath=..., nextRefreshMs=...
	On the device, set the timezone with: timezone=<hours from UTC> dst=<hours>
*/

import {} from "piu/MC";
import config from "mc/config";
import Time from "time";
import Timer from "timer";
import fetch from "fetch";
import Headers from "headers";
import Net from "net";

// 1 bpp panel: the palette is black and white. With dithering off (text
// screen), any gray would threshold to one of the two anyway.
const WHITE = "white";
const BLACK = "black";

// work day: 8:00 .. 17:00, in 15 minute blocks
const WORK_START_MINUTES = 8 * 60;
const WORK_END_MINUTES = 17 * 60;
const BLOCK_MINUTES = 15;
const BLOCKS_PER_HOUR = 60 / BLOCK_MINUTES;
const HOURS = (WORK_END_MINUTES - WORK_START_MINUTES) / 60;
const TOTAL_BLOCKS = HOURS * BLOCKS_PER_HOUR;

// pomodoro presets (overridable via manifest config for testing)
const POMODORO_WORK_MS = Number(config.workMs) || 25 * 60 * 1000;
const POMODORO_BREAK_MS = Number(config.breakMs) || 5 * 60 * 1000;

// anything before 2026-01-01 GMT means the clock was never set
const MIN_VALID_TIME = 1767225600000;

// task linearizer ("next best action") endpoint; overridable via mcconfig
const LINEARIZER_HOST = String(config.linearizerHost ?? "192.168.178.76");
const LINEARIZER_PORT = Number(config.linearizerPort) || 4000;
const LINEARIZER_PATH = String(config.linearizerPath ?? "/api/today");
const NEXT_REFRESH_MS = Number(config.nextRefreshMs) || 10 * 60 * 1000;
const NEXT_RETRY_MS = Number(config.nextRetryMs) || 60 * 1000;
const HTTP_TIMEOUT_MS = Number(config.linearizerTimeoutMs) || 15 * 1000;

// partial updates accumulate ghosting on this controller; force a full
// (flashing, zero-ghost) refresh every N painted frames. The panel takes
// ~1.2 s per partial and ~2.2 s per full refresh, and this app paints at
// most once a minute, so ten frames is ~10 minutes between flashes.
const FULL_REFRESH_EVERY = Number(config.fullRefreshEvery) || 10;

// battery: read() returns millivolts on this target (hardware and simulator
// both); the provider clamps its samples to this window
const BATTERY_MIN_MV = 3000;
const BATTERY_MAX_MV = 4300;

// set battery=false (manifest config, or mcconfig battery=false) to drop the
// gauge entirely -- e.g. a panel that lives on USB power, where the reading
// is a constant and the corner is better spent on air
const kBatteryEnabled = !/^(false|0|no|off)$/i.test(String(config.battery ?? "on"));

// allow a simulated wall-clock start time for testing (mcconfig now=<ms>)
let kSimulatedNow = Number(config.now);
if (!(Number.isFinite(kSimulatedNow) && kSimulatedNow > MIN_VALID_TIME))
	kSimulatedNow = undefined;
const kSimulatedTicks = Time.ticks;

function wallTime()
{
	if (undefined !== kSimulatedNow)
		return kSimulatedNow + wrapDelta(kSimulatedTicks, Time.ticks);
	return Date.now();
}

// signed difference between two Time.ticks values, tolerant of the 32-bit wrap
function wrapDelta(from, to)
{
	let delta = (to - from) >>> 0;
	return (delta < 0x80000000) ? delta : delta - 0x100000000;
}

// Local time, done in JavaScript instead of through the runtime.
//
// Time.timezone / Time.dst are deliberately never assigned: on ESP32 those
// setters end up in newlib's setenv("TZ", ...) + tzset() running on the
// JavaScript task (xs/platforms/esp/xsHost.c, updateTZ), which is a good way to
// overrun that task's stack and reboot in a loop. Shifting the epoch and reading
// it back with the UTC getters gives the same clock, and behaves identically in
// the simulator and on the device.
//
// Set the zone with timezone=<hours from UTC> dst=<hours> (manifest config or
// mcconfig key=value). dst is a constant offset, exactly as Time.dst was: the
// runtime has no DST date rules.
const kZoneHours = (() => {
	const timezone = Number(config.timezone);
	const dst = Number(config.dst);
	if (!Number.isFinite(timezone) && !Number.isFinite(dst))
		return undefined;				// nothing configured: use the host's zone
	return (Number.isFinite(timezone) ? timezone : 0) + (Number.isFinite(dst) ? dst : 0);
})();

function zoneOffsetMs()
{
	if (undefined !== kZoneHours)
		return kZoneHours * 3600 * 1000;
	// debugger / simulator: the host zone is already known to the runtime
	return -(new Date().getTimezoneOffset() * 60000);
}

function localDate(now)
{
	return new Date(now + zoneOffsetMs());
}

function initializeTime()
{
	if (Date.now() >= MIN_VALID_TIME)
		return;					// already set (SNTP at boot, or the debugger)

	// the paperd.ink classic has no RTC peripheral; this stays a no-op there
	// and keeps the code portable to hosts that do provide one
	const RTC = device?.peripheral?.RTC;
	if (!RTC)
		return;

	try
	{
		const rtc = new RTC();
		const time = rtc.time;
		rtc.close();
		if (time >= MIN_VALID_TIME)
		{
			Time.set(time / 1000);		// RTC time is milliseconds; Time.set takes seconds
			trace(`time initialized from RTC: ${new Date()}\n`);
		}
	}
	catch (error)
	{
		trace(`RTC unavailable: ${error}\n`);
	}
}

function formatTime(date)
{
	let hours = date.getUTCHours();
	let ampm = (hours < 12) ? "AM" : "PM";
	hours = hours % 12;
	if (0 === hours)
		hours = 12;
	return `${hours}:${String(date.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

// whole minutes remaining, rounded up: the panel repaints once a minute, so
// seconds would go stale between refreshes
function formatMinutesLeft(ms)
{
	return String(Math.max(0, Math.ceil(ms / 60000)));
}

function formatHour(hour)
{
	hour = hour % 12;
	return String((0 === hour) ? 12 : hour);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// the bundled fonts cover printable ASCII only; unmapped glyphs are skipped
// silently by the renderer, so fold common Latin-1 characters down to ASCII.
const ASCII_FOLD = {
	"\u00c4": "AE", "\u00e4": "ae", "\u00d6": "OE", "\u00f6": "oe",
	"\u00dc": "UE", "\u00fc": "ue", "\u00df": "ss", "\u00c5": "A", "\u00e5": "a",
	"\u00c6": "AE", "\u00e6": "ae", "\u00d8": "O", "\u00f8": "o",
	"\u00c7": "C", "\u00e7": "c", "\u00c9": "E", "\u00e9": "e", "\u00c8": "E",
	"\u00e8": "e", "\u00ca": "E", "\u00ea": "e", "\u00cb": "E", "\u00eb": "e",
	"\u00c0": "A", "\u00e0": "a", "\u00c1": "A", "\u00e1": "a", "\u00cd": "I",
	"\u00ed": "i", "\u00ce": "I", "\u00ee": "i", "\u00cf": "I", "\u00ef": "i",
	"\u00d1": "N", "\u00f1": "n", "\u00d3": "O", "\u00f3": "o", "\u00d4": "O",
	"\u00f4": "o", "\u00d5": "O", "\u00f5": "o", "\u00da": "U", "\u00fa": "u",
	"\u00dd": "Y", "\u00fd": "y", "\u00b5": "u",
	"\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": "\"",
	"\u201d": "\"", "\u2026": "...", "\u00b7": "-", "\u2022": "-", "\u00ba": "o",
	"\u00aa": "a", "\u20ac": "EUR", "\u00a3": "GBP", "\u00b0": " deg"
};

function toAscii(text)
{
	let result = "";
	for (let i = 0; i < text.length; i++)
	{
		const ch = text[i];
		if (ch >= " " && ch <= "~")
			result += ch;
		else if (undefined !== ASCII_FOLD[ch])
			result += ASCII_FOLD[ch];
		else if ("\t" === ch || "\n" === ch)
			result += " ";
		else
			result += "?";
	}
	return result.replace(/\s+/g, " ").trim();
}

// "2026-10-30" -> "Oct 30" ("Oct 30, 2026" when the year differs from `now`)
function formatDeadline(iso, now)
{
	if (!iso)
		return "no deadline";
	const parts = String(iso).substring(0, 10).split("-");
	const year = Number(parts[0]), month = Number(parts[1]), day = Number(parts[2]);
	if (!(year && month && day))
		return "no deadline";
	const label = `${MONTHS[month - 1]} ${day}`;
	return (now && localDate(now).getUTCFullYear() === year) ? label : `${label}, ${year}`;
}

//
// skins and styles
//

const backgroundSkin = new Skin({ fill: WHITE });
const blockSkin = new Skin({ fill: BLACK });

const clockStyle = new Style({ font: "80px Pixel Operator", color: BLACK });
const statusStyle = new Style({ font: "24px Pixel Operator", color: BLACK });
const messageStyle = new Style({ font: "24px Pixel Operator", color: BLACK });
const hourStyle = new Style({ font: "16px Pixel Operator", color: BLACK });
const hintStyle = new Style({ font: "16px Pixel Operator", color: BLACK });
const kickerStyle = new Style({ font: "16px Pixel Operator", color: BLACK, horizontal: "left" });
const taskStyle = new Style({ font: "24px Pixel Operator", color: BLACK, horizontal: "left" });
const metaStyle = new Style({ font: "16px Pixel Operator", color: BLACK, horizontal: "left" });

// the card is a borderless block of text on the page: no touch, no frame,
// just the kicker that introduces it
const cardSkin = backgroundSkin;

// battery glyph: outlined shell with a solid nub, filled by segments
const batteryShellSkin = new Skin({ fill: WHITE, stroke: BLACK, borders: { left: 1, right: 1, top: 1, bottom: 1 } });
const batteryStyle = new Style({ font: "16px Pixel Operator", color: BLACK, horizontal: "right" });

const BLOCK_WIDTH = 8;
const BLOCK_HEIGHT = 20;
const BLOCK_GAP = 1;
const GROUP_GAP = 4;
const BLOCK_GROUP_WIDTH = BLOCKS_PER_HOUR * BLOCK_WIDTH + (BLOCKS_PER_HOUR - 1) * BLOCK_GAP;
const BLOCK_STEP = BLOCK_GROUP_WIDTH + GROUP_GAP;

//
// layout grid (400 x 300)
//
// The time blocks are centered as a group, which puts them at x 26..373. Every
// other element uses those edges as its margins, so the clock row, the card,
// the button and the status line all sit on one column.
//
const MARGIN_X = 12;
const GRID_RIGHT = 388;

const CLOCK_TOP = 2;
const BLOCKS_TOP = 84;
const MESSAGE_TOP = 88;			// shares the blocks band; only one is ever visible

const CARD_TOP = 132;
const CARD_LEFT = MARGIN_X;
const CARD_WIDTH = GRID_RIGHT - MARGIN_X;	// full column width
const CARD_HEIGHT = 106;
const CARD_PADDING = 10;
const CARD_TEXT_WIDTH = CARD_WIDTH - 2 * CARD_PADDING;

const STATUS_TOP = CARD_TOP + CARD_HEIGHT + 8;
const HINT_TOP = STATUS_TOP + 30;

//
// battery glyph
//

const BATTERY_SEGMENTS = 4;
const BATTERY_SEGMENT_WIDTH = 4;
const BATTERY_SEGMENT_GAP = 1;

const batterySegments = [];

class BatterySegmentBehavior extends Behavior {
	onCreate(view) {
		batterySegments.push(view);
	}
}

function batteryShell($)
{
	const segments = [];
	for (let i = 0; i < BATTERY_SEGMENTS; i++)
		segments.push(Content($, {
			left: (0 === i) ? 2 : BATTERY_SEGMENT_GAP, top: 2,
			width: BATTERY_SEGMENT_WIDTH, height: 5,
			skin: blockSkin, Behavior: BatterySegmentBehavior
		}));

	const shellWidth = 2 + BATTERY_SEGMENTS * BATTERY_SEGMENT_WIDTH +
		(BATTERY_SEGMENTS - 1) * BATTERY_SEGMENT_GAP + 2;
	return Row($, {
		left: 4, top: 1, width: shellWidth, height: 9, skin: batteryShellSkin,
		contents: segments
	});
}

//
// time blocks
//
// Deliberately flat: 36 Contents and 9 Labels as direct children of the
// application. Nesting them (band -> row -> hour column -> block row) costs a
// clip command per container level on every draw, and the display list of this
// target is small; the M5Paper original learned the same lesson the hard way.
//

const BLOCKS_LEFT = Math.idiv(400 - (HOURS * BLOCK_GROUP_WIDTH + (HOURS - 1) * GROUP_GAP), 2);
const HOUR_LABEL_TOP = BLOCKS_TOP + BLOCK_HEIGHT + 2;

const blocks = [];
const hourLabels = [];

class BlockBehavior extends Behavior {
	onCreate(view) {
		blocks.push(view);
	}
}

class HourLabelBehavior extends Behavior {
	onCreate(view) {
		hourLabels.push(view);
	}
}

function timeBlocks($)
{
	const contents = [];
	for (let hour = 0; hour < HOURS; hour++)
		for (let quarter = 0; quarter < BLOCKS_PER_HOUR; quarter++)
			contents.push(Content($, {
				left: BLOCKS_LEFT + hour * BLOCK_STEP + quarter * (BLOCK_WIDTH + BLOCK_GAP),
				top: BLOCKS_TOP, width: BLOCK_WIDTH, height: BLOCK_HEIGHT,
				skin: blockSkin, Behavior: BlockBehavior
			}));
	return contents;
}

function hourLabelsOf($)
{
	const contents = [];
	for (let hour = 0; hour < HOURS; hour++)
		contents.push(Label($, {
			left: BLOCKS_LEFT + hour * BLOCK_STEP, top: HOUR_LABEL_TOP,
			width: BLOCK_GROUP_WIDTH, style: hourStyle,
			string: formatHour(WORK_START_MINUTES / 60 + hour),
			Behavior: HourLabelBehavior
		}));
	return contents;
}

// truncate text so it renders inside `width` x `lines` of `style`, the way the
// widget will actually break it into words (a plain width * lines budget is
// optimistic: wrapped lines leave ragged space at the end of each line)
function fitText(style, text, width, lines)
{
	lines = lines || 1;

	const wrapped = [];
	let current = "";
	for (const word of text.split(" "))
	{
		const candidate = current ? `${current} ${word}` : word;
		if (current && style.measure(candidate).width > width)
		{
			wrapped.push(current);
			current = word;
		}
		else
			current = candidate;
	}
	if (current)
		wrapped.push(current);

	if (wrapped.length <= lines)
		return text;

	const kept = wrapped.slice(0, lines);
	for (;;) {
		const last = kept[kept.length - 1].split(" ");
		while (last.length && style.measure(`${last.join(" ")} ..`).width > width)
			last.pop();
		if (last.length) {
			kept[kept.length - 1] = `${last.join(" ")} ..`;
			return kept.join(" ");
		}
		kept.pop();
		if (!kept.length)
			return "..";
	}
}

//
// linearizer client (next best action)
//
// fetch() (the ECMA-419 HTTP client over embedded:io/socket/tcp) reports a
// failed connection as a rejected promise, which the card can show; the older
// "http" module writes from inside the socket callback, where the same failure
// escapes as an uncatchable exception.
//

const LINEARIZER_URL = `http://${LINEARIZER_HOST}:${LINEARIZER_PORT}${LINEARIZER_PATH}`;

function withTimeout(promise, ms, message)
{
	return new Promise((resolve, reject) => {
		const timer = Timer.set(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				Timer.clear(timer);
				resolve(value);
			},
			(error) => {
				Timer.clear(timer);
				reject(error);
			}
		);
	});
}

// resolves with the `data` object of GET /api/today; rejects on any failure
function fetchToday()
{
	return withTimeout(
		// fetch() only converts a plain object into Headers for POST/PUT, so
		// hand the client a real Headers instance
		fetch(LINEARIZER_URL, { headers: new Headers([["Accept", "application/json"]]) }).then(
			(response) => {
				if (!response.ok)
					throw new Error(`linearizer: HTTP ${response.status}`);
				return response.json();
			}
		),
		HTTP_TIMEOUT_MS, "linearizer: timeout"
	).then((json) => json?.data ?? null);
}

//
// behaviors
//

class AppBehavior extends Behavior {
	onCreate(application, data) {
		this.data = data;
		this.lastMinute = -1;
		this.phase = null;			// null | "work" | "break"
		this.endsAt = 0;			// Time.ticks when current phase ends
		this.completed = 0;			// finished work sessions this run
		this.nextAt = 0;			// Time.ticks when to (re)fetch the next action
		this.fetching = false;		// request in flight?
		this.battery = null;		// battery peripheral, when there is one
		this.batteryLevel = -1;		// last shown percent, -1 = never shown
		this.frames = 0;			// painted frames since boot (for refresh cadence)
		this.tone = null;			// piezo buzzer, when there is one
	}
	onDisplaying(application) {
		if (undefined === kSimulatedNow)
			initializeTime();

		// hardware button 1 (top) toggles the pomodoro timer
		const ButtonOne = device.peripheral?.button?.One;
		if (ButtonOne)
		{
			const app = application;
			const button = new ButtonOne({
				onPush() {
					if (button.pressed)
						app.delegate("togglePomodoro");
				}
			});
		}

		// hardware button 2 triggers an immediate todo pull refresh
		const ButtonTwo = device.peripheral?.button?.Two;
		if (ButtonTwo)
		{
			const app = application;
			const button = new ButtonTwo({
				onPush() {
					if (button.pressed)
						app.delegate("buttonRefresh");
				}
			});
		}

		// the piezo buzzer announces pomodoro phase changes
		const Tone = device.peripheral?.tone?.Default;
		if (Tone)
		{
			try { this.tone = new Tone(); }
			catch (error) { trace(`buzzer unavailable: ${error}\n`); }
		}

		// the battery gauge is whatever the host offers (device and simulator
		// both provide device.peripheral.battery.Default); hidden when there is
		// none, and when battery=false is configured
		const Battery = kBatteryEnabled ? device.peripheral?.battery?.Default : undefined;
		if (Battery)
		{
			try { this.battery = new Battery(); }
			catch (error) { trace(`battery unavailable: ${error}\n`); }
		}
		const gauge = this.data["BATTERY"];
		if (gauge.visible !== Boolean(this.battery))
			gauge.visible = Boolean(this.battery);

		// text screen on a 1 bpp panel: threshold, do not error-diffuse.
		// Atkinson would speckle every anti-aliased glyph edge.
		screen.configure?.({ dither: false });

		this.update(application);
		application.defer("refreshNextAction");		// paint first, then reach out
		application.interval = 1000;
		application.start();
	}
	onTimeChanged(application) {
		this.update(application);
	}
	// the only thing that ever marks the screen dirty is a changed string or a
	// changed visibility; count those frames and periodically re-converge
	// ghosting with a full refresh (the driver's first update after boot is
	// full by itself)
	markFrame(application, dirty) {
		if (!dirty)
			return;
		this.frames += 1;
		if (0 === this.frames % FULL_REFRESH_EVERY)
			screen.configure?.({ refresh: true });
	}
	update(application) {
		const data = this.data;
		const now = wallTime();
		const clockIsSet = now >= MIN_VALID_TIME;
		let dirty = false;

		const clockString = clockIsSet ? formatTime(localDate(now)) : "--:--";
		if (data["CLOCK"].string !== clockString) {
			data["CLOCK"].string = clockString;
			dirty = true;
		}

		const local = localDate(now);
		const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
		if (minutes !== this.lastMinute) {
			this.lastMinute = minutes;

			const inWorkDay = clockIsSet && minutes >= WORK_START_MINUTES && minutes < WORK_END_MINUTES;
			const elapsed = Math.floor((minutes - WORK_START_MINUTES) / BLOCK_MINUTES);

			// one pass over both arrays: outside work hours the whole band is hidden
			for (let i = 0; i < TOTAL_BLOCKS; i++) {
				const visible = inWorkDay && (i >= elapsed);
				if (blocks[i].visible !== visible) {
					blocks[i].visible = visible;
					dirty = true;
				}
			}
			for (let i = 0; i < HOURS; i++) {
				if (hourLabels[i].visible !== inWorkDay) {
					hourLabels[i].visible = inWorkDay;
					dirty = true;
				}
			}

			let message = "";
			if (!clockIsSet)
				message = "Clock not set";
			else if (!inWorkDay)
				message = "Outside work hours (8-5)";
			if (data["MESSAGE"].string !== message) {
				data["MESSAGE"].string = message;
				dirty = true;
			}

			dirty |= this.updateBattery();
		}

		dirty |= this.updatePomodoro();
		this.maybeRefreshNextAction(application);

		this.markFrame(application, dirty);
	}
	//
	// battery gauge
	//
	updateBattery() {
		if (!this.battery)
			return false;

		let mv;
		try { mv = this.battery.read(); }
		catch (error) { trace(`battery read failed: ${error}\n`); return false; }
		if (!Number.isFinite(mv))
			return false;

		// read() is millivolts on this target (device and simulator)
		const fraction = Math.max(0, Math.min(1, (mv - BATTERY_MIN_MV) / (BATTERY_MAX_MV - BATTERY_MIN_MV)));

		const percent = Math.round(fraction * 100);
		if (percent === this.batteryLevel)
			return false;
		this.batteryLevel = percent;

		this.data["BATTERY_LABEL"].string = `${percent}%`;
		const lit = Math.round(fraction * batterySegments.length);
		for (let i = 0; i < batterySegments.length; i++) {
			const visible = (i < lit);
			if (batterySegments[i].visible !== visible)
				batterySegments[i].visible = visible;
		}
		return true;
	}
	//
	// next best action card
	//
	showNextAction(kicker, task, meta) {
		const data = this.data;
		let dirty = false;
		if (data["NEXT_KICKER"].string !== kicker) {
			data["NEXT_KICKER"].string = kicker;
			dirty = true;
		}
		if (data["NEXT_TASK"].string !== task) {
			data["NEXT_TASK"].string = task;
			dirty = true;
		}
		if (data["NEXT_META"].string !== meta) {
			data["NEXT_META"].string = meta;
			dirty = true;
		}
		return dirty;
	}
	maybeRefreshNextAction(application) {
		if (0 > wrapDelta(this.nextAt, Time.ticks))
			return;
		this.refreshNextAction(application);
	}
	// button 2: pull the todo list now, even if a fetch is in flight --
	// drop the current one and re-request
	buttonRefresh(application) {
		this.fetching = false;
		this.refreshNextAction(application);
	}
	refreshNextAction(application) {
		if (this.fetching)
			return;

		// no point timing out when there is no network at all (on the device this
		// means the SSID in manifest.json is unset or the access point is gone)
		if (!Net.get("IP"))
		{
			this.nextAt = Time.ticks + NEXT_RETRY_MS;
			const dirty = this.showNextAction("NEXT BEST ACTION", "Linearizer unreachable", "no network connection");
			this.markFrame(application, dirty);
			return;
		}

		const self = this;
		this.fetching = true;
		this.markFrame(application, this.showNextAction("NEXT BEST ACTION", "Loading...", `${LINEARIZER_HOST}:${LINEARIZER_PORT}`));
		fetchToday().then(
			(data) => {
				self.fetching = false;
				self.nextAt = Time.ticks + NEXT_REFRESH_MS;
				self.applyNextAction(application, data);
			},
			(error) => {
				self.fetching = false;
				self.nextAt = Time.ticks + NEXT_RETRY_MS;		// retry soon
				trace(`linearizer: ${error}\n`);
				self.markFrame(application, self.showNextAction("NEXT BEST ACTION", "Linearizer unreachable",
					fitText(metaStyle, String(error?.message ?? error), CARD_TEXT_WIDTH, 1)));
			}
		);
	}
	applyNextAction(application, data) {
		const task = data?.task;
		if (!task || !task.actionable) {
			this.markFrame(application, this.showNextAction("NEXT BEST ACTION", "Nothing to do", "no actionable tasks"));
			return;
		}

		const scores = task.scores ?? {};
		const parts = [];
		if (task.project?.name)
			parts.push(toAscii(task.project.name));
		if (scores.quadrant)
			parts.push(scores.quadrant);
		parts.push(formatDeadline(task.effective_deadline ?? task.deadline, wallTime()));
		if ("plan" !== data.source)
			parts.push("all projects");

		this.markFrame(application, this.showNextAction(
			"NEXT BEST ACTION",
			fitText(taskStyle, toAscii(task.name ?? "(untitled)"), CARD_TEXT_WIDTH, 2),
			fitText(metaStyle, parts.join("  |  "), CARD_TEXT_WIDTH, 1)
		));
	}
	beep(pattern) {
		const tone = this.tone;
		if (!tone)
			return;
		try {
			if ("break" === pattern) {		// work over: three rising beeps
				tone.tone(880, 150);
				Timer.set(() => { try { tone.tone(988, 150); } catch (e) {} }, 250);
				Timer.set(() => { try { tone.tone(1175, 250); } catch (e) {} }, 500);
			}
			else {							// break over: one beep
				tone.tone(660, 300);
			}
		}
		catch (error) { trace(`buzzer: ${error}\n`); }
	}
	updatePomodoro() {
		const data = this.data;
		let status;
		let dirty = false;
		if (this.phase) {
			let remaining = wrapDelta(Time.ticks, this.endsAt);
			if (remaining <= 0) {
				if ("work" === this.phase) {
					this.completed += 1;
					this.phase = "break";
					remaining = POMODORO_BREAK_MS;
					this.beep("break");
				}
				else {
					this.phase = "work";
					remaining = POMODORO_WORK_MS;
					this.beep("work");
				}
				this.endsAt = Time.ticks + remaining;
			}
			status = (("work" === this.phase) ? "Work " : "Break ") + formatMinutesLeft(remaining) + " min";
			if (0 < this.completed)
				status += `  |  Done: ${this.completed}`;
		}
		else {
			// nothing running: only the session count is worth showing
			status = (0 < this.completed) ? `Done: ${this.completed}` : "";
		}
		if (data["STATUS"].string !== status) {
			data["STATUS"].string = status;
			dirty = true;
		}
		return dirty;
	}
	togglePomodoro(application) {
		if (this.phase) {
			this.phase = null;
		}
		else {
			this.phase = "work";
			this.endsAt = Time.ticks + POMODORO_WORK_MS;
		}
		this.updatePomodoro();
		this.markFrame(application, true);
	}
}

//
// application
//

const PomodoroApplication = Application.template($ => ({
	// Two separate fixed buffers bound the frame, and each reports its own
	// overflow: the poco display list (displayListLength) and the view command
	// list (commandListLength, default 1024 bytes). Every visible view
	// intersecting the dirty area queues a DrawContent (32 B) or DrawString
	// (40 B) command, and the 64-bit simulator inflates both by 50% and renders
	// in a single pass -- size them for the device, not the simulator. (And do
	// NOT re-add the M5Paper manifest's "creation": {"static": 98304}: on this
	// PSRAM-less target that slot-heap reservation tips the boot into
	// "fixed size heap" exhaustion; the target defaults are sufficient.)
	displayListLength: 16 * 1024,
	commandListLength: 8 * 1024,
	left: 0, right: 0, top: 0, bottom: 0,
	skin: backgroundSkin,
	Behavior: AppBehavior,
	contents: [
		Label($, {
			anchor: "CLOCK", top: CLOCK_TOP, left: 0, right: 0,
			style: clockStyle
		}),
		// small battery gauge in the top-right corner, tucked above the clock
		// digits (an 80px Pixel Operator string can reach this far right)
		Row($, {
			anchor: "BATTERY", top: 4, right: MARGIN_X, height: 11, skin: backgroundSkin,
			contents: [
				Label($, {
					anchor: "BATTERY_LABEL", top: 0, width: 44,
					style: batteryStyle, string: ""
				}),
				batteryShell($),
				Content($, { left: 0, top: 3, width: 2, height: 5, skin: blockSkin })
			]
		}),
		// the work-day band: 36 blocks + 9 hour labels, flat (see timeBlocks)
		...timeBlocks($),
		...hourLabelsOf($),
		Label($, {
			anchor: "MESSAGE", top: MESSAGE_TOP, left: 0, right: 0,
			style: messageStyle
		}),
		// next best action: below the time blocks, the full width of the column
		Container($, {
			anchor: "NEXT", top: CARD_TOP, left: CARD_LEFT, width: CARD_WIDTH, height: CARD_HEIGHT,
			skin: cardSkin,
			contents: [
				Label($, {
					anchor: "NEXT_KICKER", top: 6, left: CARD_PADDING, right: CARD_PADDING,
					style: kickerStyle, string: "NEXT BEST ACTION"
				}),
				Text($, {
					anchor: "NEXT_TASK", top: 28, left: CARD_PADDING, right: CARD_PADDING,
					height: 52, style: taskStyle, string: "Loading..."
				}),
				Label($, {
					anchor: "NEXT_META", bottom: 6, left: CARD_PADDING, right: CARD_PADDING,
					style: metaStyle
				})
			]
		}),
		Label($, {
			anchor: "STATUS", top: STATUS_TOP, left: MARGIN_X, right: MARGIN_X,
			style: statusStyle
		}),
		// the panel has no touch: say what the buttons do
		Label($, {
			top: HINT_TOP, left: 0, right: 0,
			style: hintStyle, string: "B1 start/stop   B2 refresh"
		})
	]
}));

export default new PomodoroApplication({});