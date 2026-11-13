"use strict";
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
    try { await fn(b); } catch (e) { alert(e.message); }
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
const state = { me: null, status: null, tab: "wizard", wiz: 0, cache: {} };
const TABS = [["wizard", "Setup"], ["sendspin", "Sendspin"], ["audio", "Audio"], ["bluetooth", "Bluetooth"], ["wifi", "WiFi"], ["system", "System"], ["power", "Power"], ["account", "Account"]];

async function boot() {
  try {
    state.status = await api("/api/status");
    state.me = state.status.username;
    if (state.status.setup_complete && state.tab === "wizard" && !state.tabChosen) state.tab = "sendspin";
  } catch (e) { state.me = null; }
  render();
}

function render() {
  $app.textContent = "";
  if (!state.me) return $app.append(loginView());
  const nav = h("nav", {}, TABS.map(([id, label]) => {
    const b = h("button", { class: "nav" + (state.tab === id ? " on" : ""), onclick: () => { state.tab = id; state.tabChosen = true; state.menu = false; render(); } }, label);
    b.insertAdjacentHTML("afterbegin", ICONS[id]); // static constants only
    return b;
  }));
  const main = h("main", { class: "content" }, h("h1", { class: "page-title" }, TABS.find(t => t[0] === state.tab)[1]));
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
  const go = async () => {
    try { await api("/api/login", { username: u.value, password: p.value }); await boot(); }
    catch (e) { msg.textContent = e.message; }
  };
  p.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  return h("div", { class: "login card" }, h("h2", {}, "SendspinPi"), h("p", {}, "Sign in to manage this player."),
    h("label", {}, "Username"), u, h("label", {}, "Password"), p, h("button", { class: "b", onclick: go }, "Log in"), msg);
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
      const v = await api("/api/sendspin/versions");
      const log = h("div", {});
      const next = h("div", {});
      const ready = () => { next.textContent = ""; next.append(nav(null)); };
      body.append(h("p", {}, "Sendspin is installed from PyPI into its own isolated environment. On a Pi Zero 2 W this can take several minutes – please keep this page open."),
        h("p", {}, v.installed ? ["Installed: ", h("span", { class: "tag ok" }, "v" + v.installed), v.latest && v.latest !== v.installed ? [" – latest is v" + v.latest + " (you can update later in the Sendspin tab)"] : ""] :
          ["Not installed yet", v.latest ? " (latest: v" + v.latest + ")" : ""]), log, next);
      if (v.installed) ready();
      else log.append(btn("Install Sendspin", async b => {
        const r = await api("/api/sendspin/install", {});
        b.style.display = "none";
        log.append(jobView(r.job, st => { if (st === "ok") ready(); else log.append(btn("Retry", () => { render(); })); }, "Install complete. Sendspin is ready to use.", "Install failed. Check your internet connection and try again."));
      }));
    },
    // 3 audio
    async () => {
      const a = await api("/api/audio");
      const isBt = a.selected === "sendspin_bt" || (a.selected || "").startsWith("bluealsa");
      if (!state.audioMode) state.audioMode = isBt ? "bluetooth" : "wired";
      let sel = isBt ? "" : (a.selected || ""), btInUse = isBt, btDevice = isBt ? a.selected : "";
      const log = h("div", {}), panel = h("div", {});
      const seg = h("div", { class: "seg" }, [["wired", "Speakers or DAC"], ["bluetooth", "Bluetooth speaker"]].map(([m, label]) =>
        h("button", { class: state.audioMode === m ? "on" : "", onclick: () => { state.audioMode = m; render(); } }, label)));
      const testBtn = getDev => btn("Play test tone", async () => {
        log.textContent = ""; const r = await api("/api/audio/test", { device: getDev() });
        log.append(jobView(r.job, null, "Test finished.", "Test failed."));
      }, "sec");
      if (state.audioMode === "wired") {
        panel.append(deviceList(a, v => { sel = v; }, sel),
          h("details", { class: "more" }, h("summary", {}, "Using an I²S DAC HAT?"), overlayPicker(a, () => render())),
          testBtn(() => sel), log);
      } else {
        const b = await api("/api/bluetooth");
        if (!b.available) panel.append(h("p", { class: "err" }, b.error || "Bluetooth is not available on this Pi."));
        else {
          btInUse = !!b.selected; btDevice = b.selected ? "sendspin_bt" : "";
          panel.append(btPanel(b, () => render(), { banner: true }));
        }
      }
      body.append(h("p", {}, "Where should the sound come out?"), seg, panel,
        nav(async () => {
          if (state.audioMode === "wired") await api("/api/sendspin/config", { audio_device: sel });
          else if (!btInUse && !confirm("No Bluetooth speaker is selected yet. Continue anyway?")) return false;
        }, state.audioMode === "wired" ? "Save & next" : "Next"));
    },
    // 4 connect
    async () => {
      const outLabel = await outputLabel();
      const stat = h("div", {}), pair = h("div", {}), logs = h("pre", {}, "…");
      const refresh = async () => {
        if (!stat.isConnected) return;
        try {
          const info = (await api("/api/status")).sendspin.service;
          stat.textContent = "";
          stat.append("Player service: ", h("span", { class: "tag " + (info.active === "active" ? "ok" : "warn") }, info.active));
          const l = await api("/api/sendspin/logs?n=40");
          logs.textContent = l.logs || "(no logs yet)";
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
      body.append(h("p", {}, "All set. Use the other tabs to update Sendspin or the OS, change WiFi, or reboot. You can re-run this guide any time from the Setup tab."),
        btn("Go to dashboard", () => { state.tab = "sendspin"; state.wiz = 0; state.tabChosen = true; boot(); }));
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
    if (d.in_use) links.append(link("Stop using", async () => { await post("use", ""); onChange(); }));
    if (d.paired) links.append(link("Forget", async () => { if (confirm("Forget " + d.name + "?")) { await post("forget", d.mac); onChange(); } }, "bad"));
    if (links.children.length) acts.append(links);
    return h("div", { class: "dev-row" },
      h("div", { class: "dev-head" }, h("div", {}, h("b", {}, d.name), h("small", {}, d.mac)), tag),
      temp ? h("div", { class: "callout" }, "This pairing is temporary and will be lost when the Pi restarts. Put the speaker in pairing mode and press Make permanent.") : null,
      acts);
  };
  const paint = (devs, scanned) => {
    mineBox.textContent = nearList.textContent = "";
    const cur = devs.find(d => d.in_use);
    const mine = devs.filter(d => d.paired || d.in_use), nearby = devs.filter(d => !d.paired && !d.in_use);
    if (mine.length) mineBox.append(...[h("div", { class: "group-title" }, "My speakers"),
      cur && cur.paired && opts.banner ? h("div", { class: "flash" }, cur.name + " is set as your Sendspin output.") : null,
      devs.some(d => d.in_use && !d.paired) ? h("div", { class: "callout" }, "The Pi has forgotten this speaker. It pairs again automatically when the speaker is switched on and nearby, or put it in pairing mode and press Pair again.") : null,
      ...mine.map(device)].filter(Boolean));
    // While a speaker is connected, keep other devices out of the way until the user scans
    const busy = devs.some(d => d.connected || d.in_use);
    nearList.append(...(busy && !scanned ? [h("p", { class: "mut" }, "Looking for another speaker? Press Scan.")]
      : nearby.length ? nearby.map(device)
      : [h("p", { class: "mut" }, "Switch your speaker to pairing mode, then press Scan.")]));
  };
  paint(b.devices);
  wrap.append(mineBox, h("div", { class: "group-title" }, "Add a speaker"),
    btn("Scan", async () => { nearList.textContent = "Scanning for 8 seconds…"; const r = await api("/api/bluetooth/scan", {}); paint(r.devices, true); }, "sec"),
    nearList, log);
  return wrap;
}

function overlayPicker(a, onApplied) {
  const sel = h("select", {}, h("option", { value: "" }, "None / USB / onboard (no overlay)"),
    Object.entries(a.overlays).map(([k, v]) => h("option", { value: k, selected: a.overlay === k }, v)));
  return h("div", {}, h("label", {}, "I²S DAC HAT (writes dtoverlay to config.txt, needs reboot)"), sel,
    btn("Apply overlay", async () => {
      if (!confirm("Apply this DAC overlay? A reboot is needed afterwards.")) return;
      await api("/api/audio/overlay", { overlay: sel.value });
      if (confirm("Saved. Reboot now to activate it?")) { await api("/api/power", { action: "reboot" }); alert("Rebooting… reload this page in a minute."); }
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
  wizard,
  async sendspin(main) {
    const s = state.status, sp = s.sendspin;
    const out = h("div", {});
    const log = h("div", {});
    const act = (fn, done) => async () => { log.textContent = ""; const r = await fn(); log.append(jobView(r.job, st => { if (st === "ok") { state.flash = done; boot_keep(); } }, done, "Failed. See the log above.")); };
    if (state.flash) { main.append(h("div", { class: "flash" }, state.flash)); state.flash = null; }
    const latest = h("span", {}, "checking…");
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
      h("div", { class: "card" }, h("h2", {}, "Logs"), out, btn("Refresh", () => loadLogs(out), "sec"),
        btn("Setup guide", () => { state.tab = "wizard"; state.wiz = 0; render(); }, "sec")));
    async function svc(a) { await api("/api/sendspin/service", { action: a }); await boot_keep(); }
    loadLogs(out);
  },
  async audio(main) {
    const a = await api("/api/audio");
    let sel = a.selected;
    const raw = h("pre", {}, "Loading…");
    api("/api/audio/devices").then(r => { raw.textContent = r.text || "(none)"; }).catch(e => { raw.textContent = e.message; });
    const log = h("div", {});
    main.append(h("div", { class: "card" }, h("h2", {}, "Audio output"), overlayPicker(a, () => render()),
      h("h3", {}, "Output device"), deviceList(a, v => { sel = v; }, a.selected),
      h("label", {}, "Custom device (index, name prefix or ALSA name)"),
      (() => { const i = h("input", { placeholder: "e.g. plughw:CARD=Device,DEV=0" }); i.addEventListener("input", () => { if (i.value) sel = i.value.trim(); }); return i; })(),
      btn("Save", async () => { const r = await api("/api/sendspin/config", { audio_device: sel }); alert("Saved" + (r.restarted ? " and player restarted" : "")); }),
      btn("Play test tone", async () => { log.textContent = ""; const r = await api("/api/audio/test", { device: sel }); log.append(jobView(r.job)); }, "sec"), log),
      h("div", { class: "card" }, h("h2", {}, "Devices as Sendspin sees them"), raw));
  },
  async bluetooth(main) {
    const card = h("div", { class: "card" }, h("p", { class: "mut" }, "Looking for speakers…"));
    main.append(card);
    const b = await api("/api/bluetooth");
    card.textContent = "";
    if (!b.available) return card.append(h("p", { class: "err" }, b.error || "Bluetooth is not available."));
    const auto = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Reconnect automatically", checked: b.auto_reconnect });
    auto.addEventListener("change", () => api("/api/bluetooth/auto", { enabled: auto.checked }).catch(e => { alert(e.message); auto.checked = !auto.checked; }));
    card.append(
      h("p", {}, "Play Sendspin through a Bluetooth speaker. Volume changes from your Sendspin server control the speaker's volume."),
      btPanel(b, () => render()),
      h("div", { class: "divider" }, h("label", { class: "switch-row" },
        h("span", {}, h("b", {}, "Reconnect automatically"), h("small", {}, "If the speaker disconnects, the Pi keeps trying to reconnect it.")), auto)),
      h("p", { class: "note" }, "On a Pi Zero 2 W, Bluetooth and WiFi share one antenna. If audio stutters, move the Pi closer to the speaker or use ethernet."));
  },
  async wifi(main) {
    const card = h("div", { class: "card" }, h("p", { class: "mut" }, "Checking the network…"));
    main.append(card);
    const w = await api("/api/wifi");
    card.textContent = "";
    if (!w.available) return card.append(h("p", { class: "err" }, "No WiFi interface found (NetworkManager required)."));
    card.append(h("div", { class: "row" }, "Current", h("span", {}, w.hotspot ? "Setup hotspot “" + w.hotspot_ssid + "” active (" + "10.42.0.1)" : (w.current_ssid || "not connected via WiFi"))));
    w.connections.forEach(c => card.append(h("div", { class: "row" }, c.name + " (" + (c.type === "802-3-ethernet" ? "ethernet" : "wifi") + ")", h("span", { class: "mut" }, c.ip || ""))));
    if (w.last_connect.state !== "idle") card.append(h("p", { class: w.last_connect.state === "failed" ? "err" : "okmsg" }, w.last_connect.message));
    const list = h("div", {});
    const ssid = h("input", { placeholder: "SSID" }), pw = h("input", { type: "password", placeholder: "Password (blank for open)" });
    const hid = h("input", { type: "checkbox" });
    const connect = async () => {
      if (!ssid.value) return alert("Enter an SSID");
      await api("/api/wifi/connect", { ssid: ssid.value, password: pw.value, hidden: hid.checked });
      alert(w.hotspot ? "Connecting… this hotspot will drop. Rejoin your normal WiFi and open http://" + state.status.system.hostname + ".local – if it fails, the hotspot comes back in about a minute." : "Connecting… reload in a few seconds to check.");
      setTimeout(() => render(), 4000);
    };
    const scan = async b => {
      list.textContent = "Scanning…";
      const r = await api("/api/wifi/scan");
      list.textContent = "";
      if (r.error) list.append(h("p", { class: "mut" }, r.error));
      r.networks.forEach(n => list.append(h("div", { class: "row pick", onclick: () => { ssid.value = n.ssid; pw.focus(); } },
        h("span", {}, n.ssid, n.in_use ? " (connected)" : ""), h("span", { class: "mut" }, n.signal + "% · " + n.security))));
    };
    card.append(h("h3", {}, "Available networks"), list, btn("Scan", scan, "sec"),
      h("h3", {}, "Connect"), ssid, pw, h("label", {}, hid, "Hidden network"), btn("Connect", connect));
    if (w.saved.length) {
      card.append(h("h3", {}, "Saved networks"));
      w.saved.forEach(n => card.append(h("div", { class: "row" }, n, btn("Forget", async () => { if (confirm("Forget " + n + "?")) { await api("/api/wifi/forget", { name: n }); render(); } }, "sec bad"))));
    }
    scan();
  },
  async system(main) {
    // start every request now, in parallel; only the quick one blocks the page
    const upP = api("/api/system/upgradable"), auP = api("/api/updates"), suP = api("/api/selfupdate");
    const sys = (await api("/api/status")).system;
    const log = h("div", {});
    const grid = h("div", { class: "grid" }, [["OS", sys.os], ["Model", sys.model], ["Uptime", uptime(sys.uptime_s)],
      ["Memory free", sys.mem_avail_kb ? bytes(sys.mem_avail_kb * 1024) : "?"],
      ["Disk free", sys.disk ? bytes(sys.disk.free) : "?"], ["CPU temp", sys.cpu_temp_c != null ? sys.cpu_temp_c + " °C" : "?"], ["IP", sys.ips.join(", ")]]
      .map(([k, v]) => h("div", {}, h("small", {}, k), v)));
    // System updates card: buttons are there at once, the package status and automatic-update section fill in later
    const statusSlot = h("div", {}, h("p", { class: "mut" }, "Checking for updates…"));
    const updateNow = btn("Update now", async () => {
      if (!confirm("Install all updates now? Keep power connected; this can take a long time on a Pi Zero.")) return;
      log.textContent = ""; const r = await api("/api/system/apt-upgrade", {}); log.append(jobView(r.job, () => setTimeout(() => render(), 1500)));
    });
    updateNow.hidden = true;
    upP.then(up => {
      const n = up.packages.length;
      statusSlot.textContent = "";
      statusSlot.append(h("div", { class: "row" }, h("span", {}, n ? n + " update" + (n > 1 ? "s" : "") + " available" : "Everything is up to date"),
        h("span", { class: "tag " + (n ? "warn" : "ok") }, n ? "available" : "up to date")),
        n ? h("details", { class: "more" }, h("summary", {}, "View packages"), h("pre", {}, up.packages.map(p => p.name + "  " + p.old + " → " + p.new).join("\n"))) : null);
      updateNow.hidden = !n;
    }).catch(e => { statusSlot.textContent = e.message; });
    const autoSlot = h("div", { class: "divider" }, h("p", { class: "mut" }, "Loading automatic updates…"));
    auP.then(au => { autoSlot.textContent = ""; autoSlot.append(autoUpdatesSection(au)); }).catch(() => autoSlot.remove());
    main.append(h("div", { class: "card" }, grid,
      sys.reboot_required ? h("div", { class: "callout" }, "A restart is needed to finish updates. Use the Power tab when you're ready.") : null),
      lazyCard("SendspinPi updates", () => suP, selfUpdateCard, true),
      h("div", { class: "card" }, h("h2", {}, "System updates"), statusSlot,
        h("div", { style: "margin-top:8px" },
          btn("Check for updates", async () => { log.textContent = ""; const r = await api("/api/system/apt-update", {}); log.append(jobView(r.job, () => setTimeout(() => render(), 1500))); }, "sec"),
          updateNow),
        log, autoSlot));
  },
  power(main) {
    main.append(h("div", { class: "card" }, h("p", {}, "Shutting down needs physical access to power the Pi back on."),
      btn("Reboot", async () => { if (confirm("Reboot the Pi now?")) { await api("/api/power", { action: "reboot" }); alert("Rebooting… reload in about a minute."); } }),
      btn("Shut down", async () => { if (confirm("Shut down the Pi? You will need to unplug/replug power to start it again.")) { await api("/api/power", { action: "shutdown" }); alert("Shutting down."); } }, "bad")));
  },
  account(main) {
    const u = h("input", { value: state.me, autocomplete: "username" });
    const cur = h("input", { type: "password", autocomplete: "current-password" }), np = h("input", { type: "password", autocomplete: "new-password", placeholder: "Leave blank to keep" });
    main.append(h("div", { class: "card" }, h("h2", {}, "Login credentials"), h("label", {}, "Username"), u, h("label", {}, "New password (min 8 chars)"), np,
      h("label", {}, "Current password (required)"), cur,
      btn("Save", async () => { const r = await api("/api/account", { username: u.value, new_password: np.value, current_password: cur.value }); state.me = r.username; alert("Saved"); render(); })));
  }
};

function autoUpdatesSection(u) {
  const sec = h("div", {});
  if (!u.installed) return (sec.append(h("p", { class: "err" }, "Automatic updates aren't installed. Re-run the installer to add them.")), sec);
  const opts = h("div", { class: "suboptions" }), log = h("div", {});
  const details = h("pre", { hidden: true }, u.last.tail || "No log yet.");
  const msg = h("small", { class: "okmsg" });
  const sub = h("small", {}, "Checks daily and installs in the background");
  const save = async patch => {
    try { Object.assign(u, await api("/api/updates", patch)); msg.textContent = " Saved"; setTimeout(() => { msg.textContent = ""; }, 2000); }
    catch (e) { alert(e.message); }
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
  auto.addEventListener("change", () => api("/api/selfupdate", { auto: auto.checked }).catch(e => { alert(e.message); auto.checked = !auto.checked; }));
  card.append(status, h("div", { style: "margin-top:8px" },
    btn("Check for updates", async () => { Object.assign(u, await api("/api/selfupdate?check=1")); render(); }, "sec"),
    u.available ? btn("Update now", async () => {
      if (!confirm("Update SendspinPi to " + u.latest + "? The page restarts for about a minute.")) return;
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

async function loadLogs(el) { try { el.textContent = ""; el.append(h("pre", {}, (await api("/api/sendspin/logs")).logs || "(empty)")); } catch (e) { el.textContent = e.message; } }
async function boot_keep() { state.status = await api("/api/status"); render(); }

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
