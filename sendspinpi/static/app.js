"use strict";
// The browser's append()/prepend() turn null or false into the text "null"/"false"; skip them instead
for (const m of ["append", "prepend"]) {
  const native = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return native.apply(this, kids.filter(k => k != null && k !== false)); };
}
// ---------- helpers (DOM built with textContent only: SSIDs etc. are untrusted)
const $app = document.getElementById("app");
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "sendspinpi" },
    body: JSON.stringify(body)
  };
  if (body !== undefined && opt.headers) opt.headers["X-Requested-With"] = "sendspinpi";
  let r;
  try { r = await fetch(path, opt); } catch (e) { throw new Error("Cannot reach the Pi (rebooting or network changed?)"); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { state.me = null; render(); throw new Error("Logged out"); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const btn = (label, fn, cls = "") => {
  const b = h("button", { class: "b " + cls }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await fn(b); } catch (e) { tell(e.message); }
    b.disabled = false;
  });
  return b;
};
const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : (n / 1e6).toFixed(0) + " MB";
const uptime = s => { const d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + "d " : "") + hr + "h " + m + "m"; };

// Live job log. Returns element; calls onDone(status) when finished.
function jobView(jobId, onDone, okText, failText) {
  const pre = h("pre", {}, "Starting…"), status = h("div", { class: "jobstatus", hidden: true });
  (async () => {
    let since = 0, first = true;
    for (;;) {
      let st;
      try { st = await api("/api/job?id=" + jobId + "&since=" + since); } catch (e) { pre.append("\n" + e.message); return; }
      if (first && st.lines.length) { pre.textContent = ""; first = false; }
      if (st.lines.length) { pre.append(st.lines.join("\n") + "\n"); pre.scrollTop = pre.scrollHeight; }
      since = st.next;
      if (st.status !== "running") {
        const ok = st.status === "ok";
        status.className = "jobstatus " + (ok ? "ok" : "bad");
        status.textContent = ok ? (okText || "Done") : (failText || "Failed. See the log above.");
        status.hidden = false;
        if (onDone) onDone(st.status);
        return;
      }
      await sleep(1000);
    }
  })();
  return h("div", {}, pre, status);
}

// A card that appears immediately with "Loading…" and is swapped for the real one when its data
// arrives. Optional cards simply disappear if they can't be loaded.
function lazyCard(title, load, build, optional) {
  const msg = h("p", { class: "mut" }, "Loading…");
  const slot = h("div", { class: "card" }, title ? h("h2", {}, title) : null, msg);
  load().then(data => { const el = build(data); if (el) slot.replaceWith(el); else slot.remove(); })
    .catch(e => { if (optional) slot.remove(); else { msg.className = "err"; msg.textContent = e.message; } });
  return slot;
}

// ---------- state / routing
const state = { me: null, status: null, tab: "home", wiz: 0, kind: null, timer: null, menu: false };
// [id, path, label]. Every page has its own URL (History API); the server serves the app for each path.
const ROUTES = [["home", "/", "Home"], ["wizard", "/setup", "Setup"], ["sendspin", "/sendspin", "Sendspin"],
  ["audio", "/audio", "Audio output"], ["wifi", "/wifi", "Wi-Fi"], ["system", "/system", "System"],
  ["account", "/account", "Account"]];
const route = id => ROUTES.find(r => r[0] === id);
function idForPath(p) {
  p = p.replace(/\/+$/, "") || "/";
  if (p === "/bluetooth") p = "/audio";   // Bluetooth now lives on the Audio output page
  if (p === "/power") p = "/system";      // so does Power, on the System page
  const r = ROUTES.find(r => r[1] === p);
  return r ? r[0] : "home";
}
function go(id, replace) {
  const path = route(id)[1];
  if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  state.tab = id; state.menu = false;
  render();
}
window.addEventListener("popstate", () => { state.tab = idForPath(location.pathname); state.menu = false; render(); });

async function boot(status) {
  try {
    state.status = status || await api("/api/status");
    state.me = state.status.username;
    state.tab = idForPath(location.pathname);
    const done = state.status.setup_complete;
    // a new install opens the setup guide; once setup is complete the guide is hidden
    if (!done && state.tab === "home" && location.pathname === "/") { state.tab = "wizard"; history.replaceState({}, "", "/setup"); }
    if (done && state.tab === "wizard") { state.tab = "home"; history.replaceState({}, "", "/"); }
    const want = route(state.tab)[1];   // old addresses (/power, /bluetooth) become the current ones
    if (location.pathname !== want) history.replaceState({}, "", want);
  } catch (e) { state.me = null; }
  render();
}

function render() {
  clearInterval(state.timer);
  $app.textContent = "";
  if (!state.me) return $app.append(loginView());
  const nav = h("nav", {}, ROUTES.filter(r => r[0] !== "wizard" || !state.status.setup_complete).map(([id, path, label]) => {
    const a = h("a", { class: "nav" + (state.tab === id ? " on" : ""), href: path });
    a.addEventListener("click", e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(id); });
    a.insertAdjacentHTML("afterbegin", ICONS[id]); // static constants only
    a.append(label);
    return a;
  }));
  const here = route(state.tab);
  document.title = "SendspinPi · " + here[2];
  const main = h("main", { class: "content" }, h("h1", { class: "page-title" }, here[2]));
  const burger = h("button", { class: "burger", "aria-label": "Menu", "aria-expanded": String(!!state.menu), onclick: () => { state.menu = !state.menu; render(); } });
  burger.insertAdjacentHTML("afterbegin", svg('<path d="M4 7h16M4 12h16M4 17h16"/>'));
  const logout = h("button", { class: "nav logout", "aria-label": "Log out", title: "Log out", onclick: async () => { await api("/api/logout", {}); state.me = null; render(); } });
  logout.insertAdjacentHTML("afterbegin", ICONS.logout);
  $app.append(h("div", { class: "shell" + (state.menu ? " open" : "") },
    h("aside", { class: "side" },
      h("div", { class: "brand" }, burger, h("b", {}, "SendspinPi"), h("span", {}, state.status?.system?.hostname || "")),
      logout, nav, h("div", { class: "spacer" })),
    h("div", { class: "scrim", onclick: () => { state.menu = false; render(); } }),
    main));
  views[state.tab](main);
}
const svg = d => '<svg viewBox="0 0 24 24">' + d + '</svg>';
const ICONS = {
  home: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v9a1 1 0 001 1h3v-6h4v6h3a1 1 0 001-1v-9"/>'),
  wizard: svg('<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
  sendspin: svg('<path d="M4 9v6M8 6v12M12 3v18M16 7v10M20 10v4"/>'),
  audio: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/>'),
  bluetooth: svg('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>'),
  wifi: svg('<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r=".8"/>'),
  system: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  power: svg('<path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1011.4 0"/>'),
  logout: svg('<path d="M9 4H5a1 1 0 00-1 1v14a1 1 0 001 1h4"/><path d="M16 8l4 4-4 4M20 12H9"/>'),
  account: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>')
};

function loginView() {
  const u = h("input", { placeholder: "Username", autocomplete: "username", value: "admin" });
  const p = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = h("div", { class: "err" });
  const b = h("button", { class: "b", onclick: () => go() }, "Log in");
  const go = async () => {
    if (b.disabled) return;
    b.disabled = true; b.textContent = ""; b.append(h("span", { class: "spinner sm" }), "Signing in…"); msg.textContent = "";
    try { const r = await api("/api/login", { username: u.value, password: p.value }); await boot(r.status); }
    catch (e) { msg.textContent = e.message; b.disabled = false; b.textContent = "Log in"; }
  };
  p.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  return h("div", { class: "login card" }, h("h2", {}, "SendspinPi"), h("p", {}, "Sign in to manage this player."),
    h("label", {}, "Username"), u, h("label", {}, "Password"), p, b, msg);
}

// ---------- Wizard
const WIZ = ["Name", "Install", "Audio", "Connect", "Done"];
async function wizard(main) {
  const s = state.status;
  const body = h("div", { class: "card" });
  main.append(h("div", { class: "steps" }, WIZ.map((_, i) => h("i", { class: i <= state.wiz ? "on" : "" }))), body);
  const nav = (next, nextLabel = "Next", ok = true) => h("div", { style: "margin-top:12px" },
    state.wiz > 0 ? btn("Back", () => { state.wiz--; render(); }, "sec") : null,
    btn(nextLabel, async () => { if (next && (await next()) === false) return; state.wiz++; render(); }, ok ? "" : "sec"));
  body.append(h("div", { class: "eyebrow" }, "Step " + (state.wiz + 1) + " of 5"), h("h2", {}, WIZ[state.wiz]));
  const steps = [
    // 1 name
    () => {
      const name = h("input", { value: s.sendspin.settings.name || s.system.hostname, maxlength: 64 });
      body.append(h("p", {}, "Welcome! This guide gets your Pi playing synchronized audio with Sendspin. First, choose the name this player will show up as on your Sendspin server (e.g. “Kitchen”)."),
        h("label", {}, "Player name"), name,
        nav(async () => { await api("/api/sendspin/config", { name: name.value.trim() }); }));
    },
    // 2 install
    async () => {
      const v = await api("/api/sendspin/versions?latest=0");   // the PyPI lookup can be slow: fill it in afterwards
      const log = h("div", {});
      const next = h("div", {});
      const ready = () => { next.textContent = ""; next.append(nav(null)); };
      const latestSlot = h("span", {});
      body.append(h("p", {}, "Sendspin is installed from PyPI into its own isolated environment. On a Pi Zero 2 W this can take several minutes – please keep this page open."),
        h("p", {}, v.installed ? ["Installed: ", h("span", { class: "tag ok" }, "v" + v.installed)] : "Not installed yet", latestSlot), log, next);
      api("/api/sendspin/versions").then(f => {
        if (!f.latest) return;
        latestSlot.append(v.installed ? (f.latest !== v.installed ? " – latest is v" + f.latest + " (you can update later in the Sendspin tab)" : "") : " (latest: v" + f.latest + ")");
      }).catch(() => {});
      if (v.installed) ready();
      else log.append(btn("Install Sendspin", async b => {
        const r = await api("/api/sendspin/install", {});
        b.style.display = "none";
        log.append(jobView(r.job, st => { if (st === "ok") ready(); else log.append(btn("Retry", () => { render(); })); }, "Install complete. Sendspin is ready to use.", "Install failed. Check your internet connection and try again."));
      }));
    },
    // 3 audio
    async () => {
      const host = h("div", {});
      body.append(h("p", {}, "Where should the sound come out? Pick one type, then choose the output."), host,
        nav(async () => {
          const a = await api("/api/audio");
          if (!a.selected && !(await ask("No output has been chosen, so the system default will be used. Continue?"))) return false;
        }));
      await audioOutputPanel(host, { wizard: true });
    },
    // 4 connect
    async () => {
      const outLabel = await outputLabel();
      const stat = h("div", {}), pair = h("div", {}), logs = h("pre", {}, "…");
      const refresh = async () => {
        if (!stat.isConnected) return;
        if (document.hidden) return setTimeout(refresh, 4000);   // pause while the tab is in the background
        try {
          const info = (await api("/api/sendspin/state")).service;
          stat.textContent = "";
          stat.append("Player service: ", h("span", { class: "tag " + (info.active === "active" ? "ok" : "warn") }, info.active));
          const l = await api("/api/sendspin/logs?n=40");
          logs.textContent = l.logs || "No logs yet.";
          pair.textContent = "";
          if (l.pairing) pair.append(h("p", {}, "The server asked for a pairing code. Enter the code from this line on your Sendspin server:"), h("div", { class: "code" }, l.pairing));
        } catch (e) { /* ignore transient */ }
        setTimeout(refresh, 4000);
      };
      let startErr = null;
      try { await api("/api/sendspin/service", { action: "enable" }); } catch (e) { startErr = e.message; }
      body.append(h("div", { class: "row" }, h("span", {}, "Sound output"), h("span", {}, outLabel)),
        h("p", {}, "The player is starting. It appears on your network automatically: open your Sendspin server (for example Music Assistant) and look for “" + (s.sendspin.settings.name || s.system.hostname) + "” in its players list, then play something."),
        startErr ? h("p", { class: "err" }, "Couldn't start the player: " + startErr) : null,
        stat, pair,
        h("p", {}, "If the player doesn't show up, make sure the Pi and the server are on the same network, then check the log below."), logs,
        nav(null, "Finish"));
      setTimeout(refresh, 0);
    },
    // 5 done
    () => {
      api("/api/setup/complete", { complete: true });
      body.append(h("p", {}, "All set. Home shows how everything is doing, and the other pages let you change the audio output, Wi-Fi and updates. To run this guide again, use Reset on the System page."),
        btn("Go to Home", async () => { state.wiz = 0; state.status = await api("/api/status"); go("home"); }));
    }
  ];
  await steps[state.wiz]();
}

async function outputLabel() {
  const st = await api("/api/status");
  const dev = st.sendspin.settings.audio_device || "";
  if (dev === "sendspin_bt" || dev.startsWith("bluealsa")) {
    const b = await api("/api/bluetooth").catch(() => null);
    const d = b && b.devices.find(x => x.mac === b.selected);
    return "Bluetooth: " + (d ? d.name : (b && b.selected) || "speaker");
  }
  return dev || "System default";
}

// Bluetooth device list used by both the Bluetooth tab and the setup wizard.
// "My speakers" holds paired/selected speakers with their actions; "Add a speaker" scans for new ones.
function btPanel(b, onChange, opts) {
  opts = opts || {};
  const wrap = h("div", { class: "btpanel" }), mineBox = h("div", {}), nearList = h("div", {}), log = h("div", {});
  const post = (path, mac, extra) => api("/api/bluetooth/" + path, Object.assign({ mac }, extra));
  const link = (label, fn, cls) => { const l = h("button", { class: "link " + (cls || "") }, label); l.addEventListener("click", fn); return l; };
  const device = d => {
    const lost = d.in_use && !d.paired;   // selected as output, but the pairing is gone
    const tag = lost ? h("span", { class: "tag warn" }, "needs pairing")
      : d.in_use ? h("span", { class: "tag ok" }, "Sendspin output")
      : d.connected ? h("span", { class: "tag ok" }, "connected")
      : d.paired ? h("span", { class: "tag" }, "not connected") : null;
    const acts = h("div", { class: "dev-actions" });
    const temp = d.paired && d.bonded === false;   // paired, but only in memory: lost on restart
    const startPair = async () => {
      log.textContent = ""; const r = await post("pair", d.mac);
      log.append(jobView(r.job, () => setTimeout(onChange, 1200), "Paired and connected.", "Pairing failed. Put the speaker in pairing mode and try again."));
    };
    if (!d.paired) acts.append(btn(lost ? "Pair again" : "Pair", startPair));
    else {
      if (d.in_use) acts.append(btn("Play test tone", async () => {
        log.textContent = ""; const r = await api("/api/audio/test", { device: "sendspin_bt" });
        log.append(jobView(r.job, null, "Test finished. Did you hear it?", "The test failed. The log above shows why."));
      }, "sec"));
      else if (d.connected) acts.append(btn("Use for Sendspin", async () => { await post("use", d.mac); onChange(); }));
      if (d.connected) acts.append(btn("Disconnect", async () => { await post("disconnect", d.mac); onChange(); }, "sec"));
      else acts.append(btn("Connect", async () => { await post("connect", d.mac); onChange(); }));
      if (temp) acts.append(btn("Make permanent", startPair, "sec"));
    }
    const links = h("span", { class: "dev-links" });
    if (d.paired) links.append(link("Forget", async () => { if (await ask("Forget " + d.name + "? You will need to pair it again to use it.", { yes: "Forget", danger: true })) { await post("forget", d.mac); onChange(); } }, "bad"));
    if (links.children.length) acts.append(links);
    return h("div", { class: "dev-row" },
      h("div", { class: "dev-head" }, h("div", {}, h("b", {}, d.name), h("small", {}, d.mac)), tag),
      temp ? h("div", { class: "callout" }, "This pairing is temporary and will be lost when the Pi restarts. Press Make permanent, then put the speaker in pairing mode when the log asks you to.") : null,
      acts);
  };
  const paint = (devs, scanned) => {
    mineBox.textContent = nearList.textContent = "";
    const cur = devs.find(d => d.in_use);
    const mine = devs.filter(d => d.paired || d.in_use), nearby = devs.filter(d => !d.paired && !d.in_use);
    if (mine.length) mineBox.append(...[
      cur && cur.paired && opts.banner ? h("div", { class: "flash" }, cur.name + " is set as your Sendspin output.") : null,
      devs.some(d => d.in_use && !d.paired) ? h("div", { class: "callout" }, "The Pi has forgotten this speaker. It pairs again automatically when the speaker is switched on and nearby, or put it in pairing mode and press Pair again.") : null,
      ...mine.map(device)].filter(Boolean));
    // While a speaker is connected, keep other devices out of the way until the user scans
    const busy = devs.some(d => d.connected || d.in_use);
    nearList.append(...(busy && !scanned ? []
      : nearby.length ? [h("div", { class: "group-title" }, "Nearby"), ...nearby.map(device)]
      : [h("p", { class: "mut" }, "Switch your speaker to pairing mode, then press Scan.")]));
  };
  paint(b.devices);
  const scan = btn("Scan", async () => { nearList.textContent = "Scanning for 8 seconds…"; const r = await api("/api/bluetooth/scan", {}); paint(r.devices, true); }, "sec");
  wrap.append(mineBox, h("div", { class: "add-row" }, h("span", {}, b.devices.some(d => d.paired || d.in_use) ? "Add another speaker" : "Add a speaker"), scan), nearList, log);
  return wrap;
}

// One place to choose where Sendspin plays: system outputs, an I²S DAC, or a Bluetooth speaker.
// Used by the Audio output page and the setup guide.
const OUTPUT_TYPES = { system: "System outputs", i2s: "I²S DAC", bluetooth: "Bluetooth" };
async function audioOutputPanel(host, opts) {
  opts = opts || {};
  const a = await api("/api/audio");
  const out = a.output;
  const kind = state.kind || out.type;
  let sel = out.type === "bluetooth" ? "" : a.selected;
  const reload = () => { host.textContent = ""; return audioOutputPanel(host, opts); };
  const head = h("div", { class: "current" }, h("i", { class: "dot ok" }),
    h("span", {}, "In use: ", h("b", {}, { system: "System output", i2s: "I²S DAC", bluetooth: "Bluetooth speaker" }[out.type] + " · " + out.label)));
  const seg = h("div", { class: "seg" }, Object.entries(OUTPUT_TYPES).map(([k, label]) =>
    h("button", { class: kind === k ? "on" : "", onclick: () => { state.kind = k; reload(); } }, label)));
  const panel = h("div", {}), log = h("div", {});
  host.append(head, seg, panel);
  const useBtn = type => btn("Use this output", async () => {
    const r = await api("/api/sendspin/config", { audio_device: sel, audio_type: type });
    await reload();
    host.prepend(h("div", { class: "flash" }, "Output changed" + (r.restarted ? " and the player restarted." : ".")));
  });
  const testBtn = () => btn("Play test tone", async () => {
    log.textContent = ""; const r = await api("/api/audio/test", { device: sel });
    log.append(jobView(r.job, null, "Test finished. Did you hear it?", "The test failed. The log above shows why."));
  }, "sec");
  if (kind === "system") {
    panel.append(deviceList(a, v => { sel = v; }, sel), h("div", { style: "margin-top:8px" }, useBtn("system"), testBtn()), log);
    if (!opts.wizard) {
      const raw = h("pre", {}, "Loading…"); let loaded = false;
      const custom = h("input", { placeholder: "e.g. plughw:CARD=Device,DEV=0" });
      custom.addEventListener("input", () => { if (custom.value) sel = custom.value.trim(); });
      const more = h("details", { class: "more" }, h("summary", {}, "Advanced"),
        h("label", {}, "Custom device (index, name prefix or ALSA name)"), custom,
        h("label", {}, "Devices as Sendspin sees them"), raw);
      more.addEventListener("toggle", () => { if (more.open && !loaded) { loaded = true; api("/api/audio/devices").then(r => { raw.textContent = r.text || "Nothing found."; }).catch(e => { raw.textContent = e.message; }); } });
      panel.append(more);
    }
  } else if (kind === "i2s") {
    panel.append(h("p", {}, "For DAC boards and HATs on the GPIO header (HiFiBerry, IQaudIO, PCM5102…). Choose yours, apply it, then restart the Pi."), overlayPicker(a, reload));
    if (a.overlay) panel.append(h("div", { class: "group-title" }, "Output device"), deviceList(a, v => { sel = v; }, sel),
      h("div", { style: "margin-top:8px" }, useBtn("i2s"), testBtn()), log);
  } else {
    panel.append(h("p", { class: "mut" }, "Looking for speakers…"));
    const b = await api("/api/bluetooth");
    panel.textContent = "";
    if (!b.available) return panel.append(h("p", { class: "err" }, b.error || "Bluetooth is not available on this Pi."));
    const auto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Reconnect automatically", checked: b.auto_reconnect });
    auto.addEventListener("change", () => api("/api/bluetooth/auto", { enabled: auto.checked }).catch(e => { tell(e.message); auto.checked = !auto.checked; }));
    const two = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Two-way volume", checked: b.native_volume });
    two.addEventListener("change", async () => {
      try { await api("/api/bluetooth/native-volume", { enabled: two.checked }); }
      catch (e) { tell(e.message); two.checked = !two.checked; }
    });
    panel.append(btPanel(b, reload, { banner: !!opts.wizard }),
      h("div", { class: "divider" }, h("label", { class: "switch-row" },
        h("span", {}, h("b", {}, "Reconnect automatically"), h("small", {}, "If the speaker disconnects, the Pi keeps trying to reconnect it.")), auto),
        h("label", { class: "switch-row" },
          h("span", {}, h("b", {}, "Two-way volume (beta)"), h("small", {}, "Use the speaker's own volume. Its buttons move the Sendspin slider, and the slider moves the speaker. The player restarts when you change this.")), two)),
      h("details", { class: "more" }, h("summary", {}, "Audio stuttering?"),
        h("p", { class: "note" }, "On a Pi Zero 2 W, Bluetooth and Wi-Fi share one antenna. Move the Pi closer to the speaker, or use ethernet.")));
  }
}

function overlayPicker(a, onApplied) {
  const sel = h("select", {}, h("option", { value: "" }, "None / USB / onboard (no overlay)"),
    Object.entries(a.overlays).map(([k, v]) => h("option", { value: k, selected: a.overlay === k }, v)));
  return h("div", {}, h("label", {}, "I²S DAC HAT (writes dtoverlay to config.txt, needs reboot)"), sel,
    btn("Apply overlay", async () => {
      if (!(await ask("Apply this DAC overlay? The Pi needs a restart afterwards.", { yes: "Apply" }))) return;
      await api("/api/audio/overlay", { overlay: sel.value });
      if (await ask("Saved. Restart now to activate it?", { yes: "Restart now" })) { await api("/api/power", { action: "reboot" }); restartScreen("reboot"); }
      else onApplied();
    }, "sec"));
}

function deviceList(a, onPick, selected) {
  const box = h("div", {});
  const opts = [{ v: "", l: "System default", s: "let ALSA choose" }].concat(a.cards.map(c => ({ v: c.alsa, l: c.label, s: c.alsa })));
  if (selected && !opts.some(o => o.v === selected)) opts.push({ v: selected, l: "Custom: " + selected, s: "" });
  opts.forEach(o => {
    const r = h("input", { type: "radio", name: "dev", checked: o.v === selected });
    r.addEventListener("change", () => onPick(o.v));
    box.append(h("label", { class: "row pick" }, h("span", {}, r, h("span", {}, o.l)), h("span", { class: "mut" }, o.s)));
  });
  if (!a.cards.length) box.append(h("p", { class: "err" }, "No ALSA sound cards found. Plug in a USB DAC or apply an I²S overlay and reboot." + (a.error ? " (" + a.error + ")" : "")));
  return box;
}

// ---------- Tabs
const views = {
  async home(main) {
    const banner = h("div", { class: "summary" }), alerts = h("div", { class: "alerts" }), groups = h("div", {});
    main.append(banner, alerts, groups);
    const chip = (text, id) => { const c = h("a", { class: "chip", href: route(id)[1] }, text); c.addEventListener("click", e => { e.preventDefault(); go(id); }); alerts.append(c); };
    // a labelled row: muted label on the left, value on the right (with an optional status dot)
    const item = (label, value, dot, sub) => h("div", { class: "row" }, h("span", {}, label),
      h("span", { class: "val" }, dot ? h("i", { class: "dot " + dot }) : null, h("span", {}, value), sub ? h("small", {}, sub) : null));
    // one card per area; its title links to the page where that area is managed
    const group = (title, id, rows) => {
      const t = h("a", { class: "group-link", href: route(id)[1] }, "Manage");
      t.addEventListener("click", e => { e.preventDefault(); go(id); });
      return h("div", { class: "card kv" }, h("div", { class: "section-head" }, h("h2", {}, title), t), ...rows);
    };
    const paint = d => {
      const w = d.wifi, p = d.player, sys = d.system, o = d.output, bt = d.bluetooth, v = d.volume, pb = p.playback || {};
      const svc = p.service.active;
      // what the player is doing right now: a headline, a dot colour, a line of detail and (if it needs attention) an issue
      let ps;
      if (!p.installed) ps = { title: "Not installed", dot: "bad", sub: "Sendspin isn't installed yet. Open the Sendspin page to set it up.", issue: "The player is not installed" };
      else if (svc === "activating") ps = { title: "Starting…", dot: "warn", sub: "The player is starting up.", issue: null };
      else if (svc !== "active") ps = { title: "Stopped", dot: "bad", sub: "The player service isn't running.", issue: "The player is stopped" };
      else if (!pb.connected) ps = { title: "Waiting for a server", dot: "warn", sub: "Add this player (" + p.name + ") in your Sendspin server.", issue: "The player isn't connected to a server" };
      else if (pb.state === "playing") ps = { title: "Playing", dot: "ok pulse", sub: pb.server ? "From " + pb.server : "Audio is streaming" };
      else ps = { title: "Connected", dot: "ok", sub: (pb.state === "idle" ? "Nothing playing" : "Ready") + (pb.server ? " · " + pb.server : "") };
      let net;
      if (w.connected) net = [w.ssid, "ok", [w.ip, w.signal != null ? w.signal + "%" : null].filter(Boolean).join(" · ")];
      else if (w.hotspot) net = ["Setup hotspot", "warn", "Join it and open 10.42.0.1"];
      else if (w.ethernet) net = ["Ethernet", "ok", w.ethernet.ip];
      else net = [w.available ? "Not connected" : "No Wi-Fi", "bad", ""];
      const temp = sys.cpu_temp_c, tdot = temp == null ? null : temp >= 80 ? "bad" : temp >= 70 ? "warn" : "ok";
      const pct = v.level == null ? null : Math.max(0, Math.min(100, v.level));
      const volume = v.muted ? "Muted" : pct == null ? "Not set yet" : pct + "%";

      // the banner only appears when something needs attention
      const issues = [];
      if (ps.issue) issues.push(ps.issue);
      if (!w.connected && !w.ethernet) issues.push(w.hotspot ? "Running as a setup hotspot" : "Not connected to a network");
      if (bt && !bt.connected) issues.push("The Bluetooth speaker is not connected");
      if (tdot === "bad") issues.push("The CPU is very hot");
      banner.className = "summary warn";
      banner.hidden = !issues.length;
      banner.textContent = "";
      if (issues.length) banner.append(h("i", { class: "dot warn" }), h("span", {}, issues.join(" · ")));

      const manage = id => { const t = h("a", { class: "group-link", href: route(id)[1] }, "Manage"); t.addEventListener("click", e => { e.preventDefault(); go(id); }); return t; };
      const hero = h("div", { class: "card hero" },
        h("div", { class: "hero-top" }, h("i", { class: "dot big " + ps.dot }),
          h("div", { class: "hero-text" }, h("h2", {}, ps.title), h("p", { class: "mut" }, ps.sub)), manage("sendspin")),
        h("div", { class: "kv" },
          item("Player", p.name, null, p.installed ? "Sendspin v" + p.installed : null),
          item("Audio output", { system: "System output", i2s: "I²S DAC", bluetooth: "Bluetooth" }[o.type] + " · " + o.label),
          item("Volume", volume),
          pct == null || v.muted ? null : h("div", { class: "meter" }, h("i", { style: "width:" + pct + "%" }))),
        p.installed ? h("div", { class: "hero-actions" }, btn(svc === "active" ? "Restart player" : "Start player", async () => {
          if (svc === "active" && !(await ask("Restart the player? Any audio that is playing will stop for a moment.", { yes: "Restart" }))) return;
          await api("/api/sendspin/service", { action: svc === "active" ? "restart" : "start" });
          paint(await api("/api/home"));
        }, "sec")) : null);
      groups.textContent = "";
      groups.append(hero, h("div", { class: "grid2" },
        group("Connections", "wifi", [
          item("Network", net[0], net[1], net[2]),
          item("Bluetooth speaker", bt ? bt.name : "None selected", bt ? (bt.connected ? "ok" : "warn") : null, bt ? (bt.connected ? "Connected" : "Not connected") : null)
        ]),
        group("Device", "system", [
          item("CPU temperature", temp == null ? "—" : temp + " °C", tdot),
          item("Uptime", uptime(sys.uptime_s)),
          item("Memory", sys.mem_avail_kb ? bytes(sys.mem_avail_kb * 1024) + " free" : "—", null, sys.mem_total_kb ? "of " + bytes(sys.mem_total_kb * 1024) : null)
        ])));
    };
    // updates are slow to look up: they get their own card when they arrive
    const updatesBox = h("div", {}), ups = [];
    const addUpdate = (text, id) => {
      ups.push([text, id]);
      updatesBox.textContent = "";
      updatesBox.append(h("div", { class: "card kv" }, h("div", { class: "section-head" }, h("h2", {}, "Updates")),
        ...ups.map(([t, i]) => { const a = h("a", { class: "group-link", href: route(i)[1] }, "View"); a.addEventListener("click", e => { e.preventDefault(); go(i); }); return h("div", { class: "row" }, h("span", {}, t), a); })));
    };
    main.append(updatesBox);
    const d0 = await api("/api/home");
    paint(d0);
    if (d0.system.reboot_required) chip("Restart needed to finish updates", "system");
    state.timer = setInterval(async () => {
      if (!groups.isConnected) return clearInterval(state.timer);
      if (document.hidden) return;   // don't poll the Pi from a background tab
      try { paint(await api("/api/home")); } catch (e) { /* the Pi may be restarting */ }
    }, 10000);
    // updates are slow to look up: show them as chips when they arrive
    api("/api/system/upgradable").then(u => { const n = u.packages.length; if (n) addUpdate(n + " system update" + (n > 1 ? "s" : "") + " available", "system"); }).catch(() => {});
    api("/api/selfupdate").then(u => { if (u.available) addUpdate("SendspinPi " + u.latest + " available", "system"); }).catch(() => {});
  },
  wizard,
  async sendspin(main) {
    const s = state.status, sp = s.sendspin;
    const out = h("div", {});
    const log = h("div", {});
    const act = (fn, done) => async () => { log.textContent = ""; const r = await fn(); log.append(jobView(r.job, st => { if (st === "ok") { state.flash = done; boot_keep(); } }, done, "Failed. See the log above.")); };
    if (state.flash) { main.append(h("div", { class: "flash" }, state.flash)); state.flash = null; }
    const latest = h("span", {}, "Checking…");
    const upBtn = !sp.installed ? btn("Install", act(() => api("/api/sendspin/install", {}), "Install complete. Sendspin is ready to use."))
      : btn("Update", act(() => api("/api/sendspin/upgrade", {}), "Update complete."));
    // the PyPI lookup is slow; fill it in when it arrives
    api("/api/sendspin/versions").then(v => {
      latest.textContent = v.latest ? "v" + v.latest : "unknown (offline?)";
      if (sp.installed) upBtn.textContent = v.latest && v.latest !== sp.installed ? "Update to v" + v.latest : "Reinstall latest";
    }).catch(() => { latest.textContent = "unknown"; });
    main.append(h("div", { class: "card" },
      h("div", { class: "row" }, "Installed version", h("span", { class: "tag " + (sp.installed ? "ok" : "bad") }, sp.installed ? "v" + sp.installed : "not installed")),
      h("div", { class: "row" }, "Latest on PyPI", latest),
      h("div", { class: "row" }, "Player service", h("span", { class: "tag " + (sp.service.active === "active" ? "ok" : "warn") }, sp.service.active + " / " + sp.service.enabled)),
      h("div", { class: "row" }, "Player name", h("span", {}, sp.settings.name || "(hostname)")),
      h("div", { class: "row" }, "Audio device", h("span", {}, sp.settings.audio_device || "default")),
      h("div", { style: "margin-top:10px" },
        upBtn,
        btn("Start", () => svc("enable"), "sec"), btn("Stop", () => svc("stop"), "sec"), btn("Restart", () => svc("restart"), "sec")),
      log),
      h("div", { class: "card" }, h("h2", {}, "Logs"), out, btn("Refresh", () => loadLogs(out), "sec")));
    async function svc(a) { await api("/api/sendspin/service", { action: a }); await boot_keep(); }
    loadLogs(out);
  },
  async audio(main) {
    const host = h("div", { class: "card" });
    main.append(host);
    await audioOutputPanel(host);
  },
  async wifi(main) {
    const now = h("div", { class: "card" }, h("p", { class: "mut" }, "Checking the network…"));
    main.append(now);
    const w = await api("/api/wifi");
    now.textContent = "";
    if (!w.available) return now.append(h("p", { class: "err" }, "No Wi-Fi interface found (NetworkManager required)."));
    const wifiConn = w.connections.find(c => c.type !== "802-3-ethernet");
    const eth = w.connections.find(c => c.type === "802-3-ethernet");
    const connected = !!w.current_ssid;
    const meta = h("div", { class: "net-meta" }, w.hotspot ? "Join it with your phone and open http://10.42.0.1/"
      : connected ? (wifiConn && wifiConn.ip) || "" : "Choose a network below to connect.");
    const notice = h("div", {});
    now.append(
      h("div", { class: "eyebrow" }, w.hotspot ? "Setup hotspot" : connected ? "Connected to" : "Not connected"),
      h("div", { class: "net-name" }, h("i", { class: "dot " + (connected ? "ok" : w.hotspot ? "warn" : "bad") }),
        h("span", {}, w.hotspot ? w.hotspot_ssid : connected ? w.current_ssid : "No Wi-Fi network")),
      meta,
      eth ? h("div", { class: "net-meta" }, "Also on ethernet" + (eth.ip ? " · " + eth.ip : "")) : null,
      notice);
    if (w.last_connect.state === "failed") notice.append(h("div", { class: "callout" }, w.last_connect.message));

    // ---- available networks (tap one to join it)
    const list = h("div", {});
    let open = null;
    const closeForm = () => { if (open) { open.remove(); open = null; } };
    const showForm = (n, after) => {
      closeForm();
      const nameIn = n ? null : h("input", { placeholder: "Network name" });
      const secure = n ? n.security !== "open" : true;
      const pw = secure ? h("input", { type: "password", placeholder: "Password", autocomplete: "off" }) : null;
      const join = async () => {
        const ssid = n ? n.ssid : nameIn.value.trim();
        if (!ssid) return tell("Enter the network name");
        await api("/api/wifi/connect", { ssid, password: pw ? pw.value : "", hidden: !n });
        closeForm();
        if (w.hotspot) tell("Connecting… this hotspot will drop. Rejoin your normal Wi-Fi and open http://" + state.status.system.hostname + ".local. If it fails, the hotspot comes back in about a minute.");
        else { notice.textContent = ""; notice.append(h("div", { class: "flash" }, "Connecting to " + ssid + "…")); setTimeout(() => render(), 6000); }
      };
      // Connect is only the main action when there is no connection yet
      open = h("div", { class: "join" }, h("b", {}, n ? "Join " + n.ssid : "Join a hidden network"), nameIn, pw,
        h("div", {}, btn("Connect", join, connected ? "sec" : ""), btn("Cancel", closeForm, "sec")));
      after.after(open);
      const first = nameIn || pw;
      if (first) first.focus();
    };
    const scan = async () => {
      closeForm();
      list.textContent = "Scanning…";
      const r = await api("/api/wifi/scan");
      list.textContent = "";
      if (r.error) list.append(h("p", { class: "mut" }, r.error));
      const cur = r.networks.find(n => n.in_use);
      if (cur && connected) meta.textContent = ((wifiConn && wifiConn.ip) || "") + " · " + cur.signal + "% signal";
      r.networks.filter(n => !n.in_use).forEach(n => {
        const row = h("div", { class: "row pick" }, h("span", {}, n.ssid, n.security !== "open" ? h("small", { class: "lock" }, "secured") : null), h("span", { class: "mut" }, n.signal + "%"));
        row.addEventListener("click", () => showForm(n, row));
        list.append(row);
      });
      if (!list.children.length) list.append(h("p", { class: "mut" }, "No other networks found."));
    };
    const hiddenLink = h("button", { class: "link" }, "Join a hidden network");
    hiddenLink.addEventListener("click", () => showForm(null, hiddenLink));
    main.append(h("div", { class: "card" },
      h("div", { class: "section-head" }, h("h2", {}, connected ? "Other networks" : "Networks"), btn("Scan", scan, "sec")),
      list, h("div", { class: "hidden-row" }, hiddenLink)));

    // ---- saved networks
    if (w.saved.length) main.append(h("div", { class: "card" }, h("h2", {}, "Saved networks"),
      ...w.saved.map(n => {
        const forget = h("button", { class: "link bad" }, "Forget");
        forget.addEventListener("click", async () => { if (await ask("Forget " + n + "? The Pi will no longer join it automatically.", { yes: "Forget", danger: true })) { await api("/api/wifi/forget", { name: n }); render(); } });
        return h("div", { class: "row" }, h("span", {}, n, n === w.current_ssid ? h("span", { class: "tag ok", style: "margin-left:8px" }, "connected") : null), forget);
      })));
    scan();
  },
  async system(main) {
    // start every request now, in parallel; only the quick one blocks the page
    const upP = api("/api/system/upgradable"), auP = api("/api/updates"), suP = api("/api/selfupdate");
    const log = h("div", {});
    api("/api/status").then(s => {   // the restart notice fills in when ready, so the page isn't held up
      if (s.system.reboot_required) main.querySelector("h1").after(h("div", { class: "callout" }, "A restart is needed to finish updates. Use Restart in the Power section below when you're ready."));
    }).catch(() => {});
    // System updates card: buttons are there at once, the package status and automatic-update section fill in later
    const statusSlot = h("div", {}, h("p", { class: "mut" }, "Checking for updates…"));
    const updateNow = btn("Update now", async () => {
      if (!(await ask("Install all updates now? Keep power connected; this can take a long time on a Pi Zero.", { yes: "Install updates" }))) return;
      log.textContent = ""; const r = await api("/api/system/apt-upgrade", {}); log.append(jobView(r.job, () => setTimeout(() => render(), 1500)));
    });
    updateNow.hidden = true;
    upP.then(up => {
      const n = up.packages.length;
      statusSlot.textContent = "";
      statusSlot.append(h("div", { class: "row" }, h("span", {}, n ? n + " update" + (n > 1 ? "s" : "") + " available" : "Everything is up to date"),
        h("span", { class: "tag " + (n ? "warn" : "ok") }, n ? "available" : "up to date")));
      if (n) statusSlot.append(h("details", { class: "more" }, h("summary", {}, "View packages"), h("pre", {}, up.packages.map(p => p.name + "  " + p.old + " → " + p.new).join("\n"))));
      updateNow.hidden = !n;
    }).catch(e => { statusSlot.textContent = e.message; });
    const autoSlot = h("div", { class: "divider" }, h("p", { class: "mut" }, "Loading automatic updates…"));
    auP.then(au => { autoSlot.textContent = ""; autoSlot.append(autoUpdatesSection(au)); }).catch(() => autoSlot.remove());
    main.append(
      lazyCard("SendspinPi updates", () => suP, selfUpdateCard, true),
      h("div", { class: "card" }, h("h2", {}, "System updates"), statusSlot,
        h("div", { style: "margin-top:8px" },
          btn("Check for updates", async () => { log.textContent = ""; const r = await api("/api/system/apt-update", {}); log.append(jobView(r.job, () => setTimeout(() => render(), 1500))); }, "sec"),
          updateNow),
        log, autoSlot),
      h("div", { class: "card" }, h("h2", {}, "Power"),
        h("p", {}, "Shutting down needs physical access to power the Pi back on."),
        btn("Restart", async () => { if (await ask("Restart the Pi now?", { yes: "Restart" })) { await api("/api/power", { action: "reboot" }); restartScreen("reboot"); } }, "sec"),
        btn("Shut down", async () => { if (await ask("Shut down the Pi? You will need to unplug and replug power to start it again.", { yes: "Shut down", danger: true })) { await api("/api/power", { action: "shutdown" }); restartScreen("shutdown"); } }, "sec bad")),
      h("div", { class: "card" }, h("h2", {}, "Reset"),
        h("p", {}, "Erase this player's settings and run setup again from the start."),
        btn("Reset everything…", resetDialog, "sec bad")));
  },
  account(main) {
    const u = h("input", { value: state.me, autocomplete: "username" });
    const cur = h("input", { type: "password", autocomplete: "current-password" }), np = h("input", { type: "password", autocomplete: "new-password", placeholder: "Leave blank to keep" });
    main.append(h("div", { class: "card" }, h("h2", {}, "Login credentials"), h("label", {}, "Username"), u, h("label", {}, "New password (min 8 chars)"), np,
      h("label", {}, "Current password (required)"), cur,
      btn("Save", async () => { const r = await api("/api/account", { username: u.value, new_password: np.value, current_password: cur.value }); state.me = r.username; tell("Saved"); render(); })));
  }
};

function autoUpdatesSection(u) {
  const sec = h("div", {});
  if (!u.installed) return (sec.append(h("p", { class: "err" }, "Automatic updates aren't installed. Re-run the installer to add them.")), sec);
  const opts = h("div", { class: "suboptions" }), log = h("div", {});
  const details = h("pre", { hidden: true }, u.last.tail || "No logs yet.");
  const msg = h("small", { class: "okmsg" });
  const sub = h("small", {}, "Checks daily and installs in the background");
  const save = async patch => {
    try { Object.assign(u, await api("/api/updates", patch)); msg.textContent = " Saved"; setTimeout(() => { msg.textContent = ""; }, 2000); }
    catch (e) { tell(e.message); }
    paint();
  };
  const choice = (type, name, checked, title, desc, onchange) => {
    const i = h("input", { type, name, checked });
    i.addEventListener("change", () => onchange(i));
    return h("label", { class: "opt" }, i, h("span", {}, h("b", {}, title), desc ? h("small", {}, desc) : null));
  };
  const paint = () => {
    opts.textContent = "";
    opts.hidden = !u.enabled;
    if (!u.enabled) return;
    const t = h("input", { type: "time", value: u.reboot_time, style: "width:auto;margin:0" });
    t.addEventListener("change", () => t.value && save({ reboot_time: t.value }));
    const lvl = u.last.level;
    opts.append(
      h("div", { class: "group" }, h("div", { class: "group-title" }, "Which updates"),
        choice("radio", "scope", u.scope === "security", "Security fixes only", "Safest choice", () => save({ scope: "security" })),
        choice("radio", "scope", u.scope === "all", "All updates", "Also bug fixes and Raspberry Pi updates", () => save({ scope: "all" }))),
      h("div", { class: "group" }, h("div", { class: "group-title" }, "Restarting"),
        choice("checkbox", "reboot", u.reboot, "Restart if an update needs it", "Music stops for about a minute", i => save({ reboot: i.checked })),
        u.reboot ? h("div", { class: "opt-time" }, "Restart at ", t) : null),
      h("div", { class: "group" }, h("div", { class: "group-title" }, "Last run"),
        h("div", { class: "lastrun" }, h("span", {}, u.last.summary, u.last.when ? h("small", {}, u.last.when) : null),
          h("span", { class: "tag " + (lvl === "bad" ? "bad" : lvl === "ok" ? "ok" : "") }, lvl === "bad" ? "problem" : lvl === "ok" ? "ok" : "waiting")),
        btn("Show log", async b => { details.hidden = !details.hidden; b.textContent = details.hidden ? "Show log" : "Hide log"; }, "sec"), log, details));
  };
  const on = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Install updates automatically", checked: u.enabled });
  on.addEventListener("change", () => save({ enabled: on.checked }));
  sec.append(h("label", { class: "switch-row" }, h("span", {}, h("b", {}, "Install updates automatically", msg), sub), on), opts);
  paint();
  return sec;
}

function selfUpdateCard(u) {
  const card = h("div", { class: "card" }, h("h2", {}, "SendspinPi updates"));
  const status = h("div", {}), log = h("pre", { hidden: true });
  const tagFor = () => u.available ? h("span", { class: "tag warn" }, u.latest + " available")
    : u.latest ? h("span", { class: "tag ok" }, "up to date") : h("span", { class: "tag" }, u.error || "unknown");
  const paint = () => {
    status.textContent = "";
    status.append(h("div", { class: "row" }, h("span", {}, "Version " + u.current), tagFor()));
  };
  const watch = async () => {
    log.hidden = false; const start = Date.now();
    while (Date.now() - start < 15 * 60 * 1000) {
      await sleep(4000);
      try {
        const r = await api("/api/selfupdate/log");
        log.textContent = r.log; log.scrollTop = log.scrollHeight;
        if (r.version !== u.current) return location.reload();
      } catch (e) { if (e.message === "Logged out") return; /* server restarting: keep waiting */ }
    }
  };
  const auto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Update SendspinPi automatically", checked: u.auto });
  auto.addEventListener("change", () => api("/api/selfupdate", { auto: auto.checked }).catch(e => { tell(e.message); auto.checked = !auto.checked; }));
  card.append(status, h("div", { style: "margin-top:8px" },
    btn("Check for updates", async () => { Object.assign(u, await api("/api/selfupdate?check=1")); render(); }, "sec"),
    u.available ? btn("Update now", async () => {
      if (!(await ask("Update SendspinPi to " + u.latest + "? The page restarts for about a minute.", { yes: "Update" }))) return;
      await api("/api/selfupdate/run", {});
      status.textContent = ""; status.append(h("p", {}, "Updating… this takes a few minutes. The page reloads when it's done."));
      watch();
    }) : null),
    log,
    h("div", { class: "divider" }, h("label", { class: "switch-row" },
      h("span", {}, h("b", {}, "Update SendspinPi automatically"), h("small", {}, "Installs new releases only. Your settings are kept.")), auto)));
  paint();
  return card;
}

async function loadLogs(el) { try { el.textContent = ""; el.append(h("pre", {}, (await api("/api/sendspin/logs")).logs || "No logs yet.")); } catch (e) { el.textContent = e.message; } }
async function boot_keep() { state.status = await api("/api/status"); render(); }

// Full-screen restart / shutdown screen. For a restart it waits until the Pi has gone down and come back,
// then reloads the page (you will need to log in again).
function restartScreen(kind) {
  clearInterval(state.timer);
  const shutdown = kind === "shutdown";
  const text = h("p", { class: "mut" }, shutdown ? "The Pi is powering off. It's safe to unplug it in about 20 seconds."
    : "This usually takes about a minute. This page reloads by itself when the Pi is back.");
  const spinner = h("div", { class: "spinner" });
  const overlay = h("div", { class: "overlay", role: "alert" }, spinner,
    h("h2", {}, shutdown ? "Shutting down" : "Restarting the Pi"), text);
  document.body.append(overlay);
  if (shutdown) {
    setTimeout(() => { spinner.remove(); overlay.querySelector("h2").textContent = "The Pi is off"; text.textContent = "Unplug the power, then plug it back in to start it again."; }, 25000);
    return;
  }
  const started = Date.now();
  let wentDown = false;
  const tick = async () => {
    let up = false;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
      const r = await fetch("/api/ping", { cache: "no-store", signal: ctl.signal });
      clearTimeout(t); up = r.ok;
    } catch (e) { up = false; }
    if (!up) wentDown = true;
    else if (wentDown) return location.reload();   // it went away and is back: show the fresh page
    const waited = Date.now() - started;
    if (!wentDown && waited > 90000) {              // never saw it go down: the restart probably didn't start
      spinner.remove(); overlay.querySelector("h2").textContent = "The Pi doesn't seem to have restarted";
      text.textContent = ""; overlay.append(btn("Reload page", () => location.reload()));
      return;
    }
    if (wentDown && waited > 150000) text.textContent = "Still waiting. Check that the Pi has power. This page keeps trying.";
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 4000);
}

// In-app dialogs (native <dialog>) instead of the browser's own popups
function modal(build, onClose) {
  const dlg = h("dialog", { class: "modal" });
  let done = false;
  const close = v => { if (done) return; done = true; dlg.close(); dlg.remove(); if (onClose) onClose(v); };
  dlg.addEventListener("cancel", e => { e.preventDefault(); close(false); });   // Esc
  dlg.append(build(close));
  document.body.append(dlg);
  dlg.showModal();
}
// ask("Forget it?", { yes: "Forget", danger: true }) -> Promise<boolean>
function ask(message, o) {
  o = o || {};
  return new Promise(res => modal(close => h("div", {},
    o.title ? h("h2", {}, o.title) : null,
    h("p", { class: "dlg-text" }, message),
    h("div", { class: "dlg-actions" }, btn("Cancel", () => close(false), "sec"),
      btn(o.yes || "Continue", () => close(true), o.danger ? "bad" : ""))), v => res(!!v)));
}
// tell("Saved") -> Promise<void>
function tell(message, o) {
  o = o || {};
  return new Promise(res => modal(close => h("div", {},
    o.title ? h("h2", {}, o.title) : null,
    h("p", { class: "dlg-text" }, message),
    h("div", { class: "dlg-actions" }, btn("OK", () => close(true)))), () => res()));
}

function resetDialog() {
  const wifiBox = h("input", { type: "checkbox" });
  modal(close => h("div", {},
    h("h2", {}, "Reset everything?"),
    h("p", {}, "This returns the player to a fresh start and opens the setup guide again. It erases:"),
    h("ul", { class: "plain" }, ["The player's name, audio output and volume", "All Bluetooth speakers and their pairings", "The I²S DAC setting", "Automatic update settings"].map(t => h("li", {}, t))),
    h("label", { class: "opt" }, wifiBox, h("span", {}, h("b", {}, "Also forget saved Wi-Fi networks"), h("small", {}, "The Pi leaves your network and starts its setup hotspot."))),
    h("p", { class: "mut" }, "Your login and the installed Sendspin version are kept."),
    h("div", { class: "dlg-actions" }, btn("Cancel", () => close(), "sec"),
      btn("Reset everything", async () => {
        const r = await api("/api/reset", { wifi: wifiBox.checked });
        close();
        state.status = await api("/api/status");
        state.wiz = 0; state.kind = null;
        if (r.forgot_wifi) tell("Reset done. The Pi is leaving your Wi-Fi and will start the SendspinPi-Setup hotspot. Join it and open http://10.42.0.1/ to set it up again.");
        else if (r.reboot_recommended) tell("Reset done. Restart the Pi (System page, Power section) so the DAC setting is removed.");
        go("wizard");
      }, "bad"))));
}

// views may be async; wrap so errors show instead of blank page
for (const k of Object.keys(views)) {
  const f = views[k];
  views[k] = async main => { try { await f(main); } catch (e) { main.append(h("p", { class: "err" }, e.message)); } };
}
// Group neighbouring buttons into equal-size rows (one rule for the whole UI)
function groupButtons(root) {
  root.querySelectorAll("button.b").forEach(b => {
    const p = b.parentElement;
    if (!p || p.classList.contains("btns") || p.dataset.grouped) return;
    const sibs = [...p.children].filter(c => c.matches("button.b"));
    p.dataset.grouped = "1";
    if (sibs.length < 2) return;
    const wrap = h("div", { class: "btns" });
    p.insertBefore(wrap, sibs[0]);
    sibs.forEach(x => wrap.append(x));
  });
}
const gbObs = new MutationObserver(() => { gbObs.disconnect(); groupButtons($app); gbObs.observe($app, { childList: true, subtree: true }); });
gbObs.observe($app, { childList: true, subtree: true });
boot();
