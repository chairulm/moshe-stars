import { initializeApp, deleteApp } from "./vendor/firebase/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "./vendor/firebase/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot
} from "./vendor/firebase/firebase-firestore.js";
import { firebaseConfig, LOGIN_DOMAIN } from "./firebase-config.js";

// ---------- routine & rewards (edit here) ----------
const GROUPS = [
  { name: "Morning", tasks: [["skip", "Skipping ×100"], ["situp", "Sit-ups ×20"]] },
  { name: "After school", tasks: [["learn", "Learning"], ["hw", "Homework"], ["play", "Play outside / sport / skating"]] },
  { name: "Night", tasks: [["duo", "Duolingo Mandarin"], ["sing", "Singing practice"], ["guitar", "Guitar practice"], ["sleep", "Asleep before 21:00"]] }
];
const REWARDS = [
  { need: 30, what: "1 hr Nintendo / TV on the weekend" },
  { need: 38, what: "1 hr Nintendo / TV + IDR 25rb" },
  { need: 42, what: "Trip to the playground" }
];

// ---------- firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- helpers ----------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const TASKS = GROUPS.flatMap(g => g.tasks);
const LABEL = Object.fromEntries(TASKS);
const MAX = TASKS.length * 5;
const STAR = '<svg class="st" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.75 5.6 6.15.9-4.45 4.33 1.05 6.12L12 16.87l-5.5 2.88 1.05-6.12L3.1 9.3l6.15-.9z" stroke-linejoin="round"/></svg>';
const CAM = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5.5" r="2.4" fill="currentColor"/></svg>';
const $ = id => document.getElementById(id);
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
const fmt = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const NAME = { moshe: "Moshe", dad: "Dad" };

let thisMonday = mondayOf(new Date());
let todayIdx = (new Date().getDay() + 6) % 7;
let week = new Date(thisMonday);
let who = null, isDad = false;
let SELF = {}, REVIEW = {};
let unsubs = [];
let LOGIN = null;
let pickedRole = "moshe";
let settingUp = false;

const selfOf = wk => SELF[wk] || {};
const revOf = wk => REVIEW[wk] || {};
function finalOn(wk, k) { const r = revOf(wk)[k]; if (r) return !!r.star; const s = selfOf(wk)[k]; return !!(s && s.on); }
function totalOf(wk) { let n = 0; for (const [id] of TASKS) for (let d = 0; d < 5; d++) if (finalOn(wk, id + ":" + d)) n++; return n; }
function level(n) { let l = null; for (const r of REWARDS) if (n >= r.need) l = r; return l; }
function moshCanEdit(wk, d) { return who === "moshe" && wk === iso(thisMonday) && d <= todayIdx; }
function authMsg(e) {
  const c = e && e.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Wrong password. Try again.";
  if (c.includes("too-many-requests")) return "Too many tries. Wait a few minutes and try again.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("network")) return "No internet connection. Try again when you're online.";
  if (c.includes("permission-denied")) return "This account isn't allowed to do that.";
  return "Something went wrong (" + (c || "error") + "). Try again.";
}

// ---------- render ----------
function render() {
  const wk = iso(week), total = totalOf(wk);
  $("total").textContent = total; $("max").textContent = MAX;
  $("fill").style.width = (total / MAX * 100) + "%";
  let open = 0; const sm = selfOf(wk), rv = revOf(wk);
  for (const k in sm) if (sm[k].on && !rv[k]) open++;
  $("pending").textContent = open ? `· ${open} not yet checked by Dad` : "";
  $("bar").querySelectorAll(".tick").forEach(t => t.remove());
  REWARDS.forEach(r => { const t = document.createElement("span"); t.className = "tick" + (total >= r.need ? " on" : ""); t.style.left = (r.need / MAX * 100) + "%"; t.textContent = r.need + "★"; $("bar").appendChild(t); });
  const nx = REWARDS.find(r => total < r.need);
  $("nextmsg").textContent = nx ? `${nx.need - total} more star${nx.need - total === 1 ? "" : "s"} to unlock: ${nx.what}` : "All rewards unlocked this week. Great job, Moshe!";
  $("rewards").innerHTML = REWARDS.map(r => `<div class="rw${total >= r.need ? " on" : ""}"><span class="need">${r.need} ★</span><span class="what">${r.what}</span><span class="state">${total >= r.need ? "Unlocked" : "Locked"}</span></div>`).join("");
  const curWeek = wk === iso(thisMonday);
  document.querySelectorAll("thead th[data-d]").forEach(th => th.classList.toggle("today", curWeek && +th.dataset.d === todayIdx));
  let html = "";
  GROUPS.forEach(g => {
    html += `<tr class="group"><th colspan="7">${g.name}</th></tr>`;
    g.tasks.forEach(([id, label]) => {
      let row = 0; html += `<tr><th class="task" scope="row">${label}</th>`;
      for (let d = 0; d < 5; d++) {
        const k = id + ":" + d, s = sm[k], r = rv[k], on = finalOn(wk, k); if (on) row++;
        const claimed = !!(s && s.on);
        const locked = !isDad && !moshCanEdit(wk, d) && !claimed && !r && !(s && s.photo);
        let badges = "";
        if (s && s.photo) badges += `<span class="badge cam">${CAM}</span>`;
        if (r) badges += `<span class="badge dad ${r.star ? "yes" : "no"}">${r.star ? "✓" : "✕"}</span>`;
        html += `<td class="${curWeek && d === todayIdx ? "todaycol" : ""}"><button class="cell${on ? " on" : ""}${claimed ? " claimed" : ""}${locked ? " locked" : ""}" data-k="${k}" ${locked ? "disabled" : ""} aria-label="${label}, ${DAYS[d]}: ${on ? "star" : "no star"}${r ? ", checked by Dad" : ""}">${STAR}${badges}</button></td>`;
      }
      html += `<td class="sum">${row}</td></tr>`;
    });
  });
  $("tbody").innerHTML = html;
  for (let d = 0; d < 5; d++) $("d" + d).textContent = TASKS.filter(([id]) => finalOn(wk, id + ":" + d)).length;
  $("dt").textContent = total;
  $("weeklabel").textContent = (curWeek ? "This week · " : "") + fmt(week) + " – " + fmt(addDays(week, 4));
  $("next").disabled = wk >= iso(thisMonday);
  renderHistory();
}
function renderHistory() {
  const weeks = [...new Set([...Object.keys(SELF), ...Object.keys(REVIEW)])].filter(w => w < iso(thisMonday)).sort().reverse().slice(0, 12);
  if (!weeks.length) { $("hist").innerHTML = '<p class="empty">Finished weeks will show up here with their reward level.</p>'; return; }
  $("hist").innerHTML = weeks.map(w => {
    const t = totalOf(w), l = level(t);
    return `<div class="hrow"><span>Week of ${fmt(parse(w))}</span><span><b>${t}★</b> · <span class="lvl">${l ? l.what : "No reward"}</span></span></div>`;
  }).join("");
}

// ---------- task sheet ----------
let cur = null, dadChoice = null;
function openSheet(k) {
  const [id, d] = k.split(":"); cur = { wk: iso(week), k, id, d: +d };
  $("shTitle").textContent = LABEL[id];
  $("shMeta").textContent = DAYS[+d] + " " + fmt(addDays(week, +d));
  $("shErr").hidden = true;
  fillSheet(); loadPhoto();
  $("shade").hidden = false; $("close").focus();
}
function fillSheet() {
  const s = selfOf(cur.wk)[cur.k] || {}, r = revOf(cur.wk)[cur.k];
  const canSelf = moshCanEdit(cur.wk, cur.d);
  $("selfBtns").hidden = !canSelf;
  $("sYes").classList.toggle("sel", !!s.on); $("sNo").classList.toggle("sel", !s.on);
  const when = s.at ? " at " + new Date(s.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  $("selfRead").textContent = canSelf ? (r ? "Dad already checked this one. You can still change yours." : "") :
    (s.on ? `Moshe says: ★ done${when}.` : "Moshe says: not done.") + (isDad ? (s.photo ? " Photo below." : " No photo added.") : "");
  $("photoCtl").hidden = !canSelf;
  $("rmPhoto").hidden = !s.photo; $("addTxt").textContent = s.photo ? "Change photo" : "Add photo (optional)";
  $("dadBox").hidden = !isDad && !r;
  $("dadBtns").hidden = !isDad; $("dadEdit").hidden = !isDad;
  if (isDad) {
    dadChoice = r ? (r.star ? "yes" : "no") : (s.on ? "yes" : "no");
    $("dNote").value = r && r.note || "";
    $("dHint").textContent = r ? "Your saved score." : "Prefilled from Moshe's own score. Save to confirm, or change it and add a reason.";
    $("dUndo").hidden = !r; $("dadRead").hidden = true; markDad();
  } else if (r) {
    $("dadRead").hidden = false;
    $("dadRead").textContent = (r.star ? "★ Dad gave a star." : "✕ Dad said no star.") + (r.note ? " Reason: " + r.note : "");
  } else $("dadRead").hidden = true;
}
function markDad() { $("dYes").classList.toggle("sel", dadChoice === "yes"); $("dNo").classList.toggle("sel", dadChoice === "no"); }
function closeSheet() { $("shade").hidden = true; cur = null; $("photo").hidden = true; $("photo").removeAttribute("src"); }
async function loadPhoto() {
  const s = selfOf(cur.wk)[cur.k] || {}; $("photo").hidden = true; $("photoMsg").hidden = true;
  if (!s.photo) return;
  const mine = cur.k; $("photoMsg").textContent = "Loading photo…"; $("photoMsg").hidden = false;
  try {
    const snap = await getDoc(doc(db, "photos", cur.wk + "_" + cur.k));
    if (!cur || cur.k !== mine) return;
    if (snap.exists()) { $("photo").src = snap.data().img; $("photo").hidden = false; $("photoMsg").hidden = true; }
    else $("photoMsg").textContent = "Photo not found.";
  } catch (e) { $("photoMsg").textContent = "Couldn't load the photo."; }
}
function showErr(m) { $("shErr").textContent = m; $("shErr").hidden = false; }

// ---------- writes (Firestore queues them offline and syncs later) ----------
function track(p) {
  $("status").textContent = navigator.onLine ? "Saving…" : "Saved on this phone · will sync when online";
  p.then(() => { $("status").textContent = "Saved"; })
   .catch(e => { const m = authMsg(e); $("status").textContent = m; if (cur) showErr(m); });
}
const writeSelf = wk => track(setDoc(doc(db, "self", wk), { week: wk, marks: selfOf(wk) }));
const writeReview = wk => track(setDoc(doc(db, "review", wk), { week: wk, items: revOf(wk) }));

function setSelf(on) {
  const { wk, k } = cur; const m = { ...selfOf(wk) }; const prev = m[k] || {};
  if (on) m[k] = { ...prev, on: true, at: Date.now() };
  else if (prev.photo) m[k] = { ...prev, on: false }; else delete m[k];
  SELF[wk] = m; render(); fillSheet(); writeSelf(wk);
}
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let side = 1100, q = .72, out = "";
    for (let n = 0; n < 7; n++) {
      const s = Math.min(1, side / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL("image/jpeg", q);
      if (out.length < 300000) return out;
      side *= .8; q = Math.max(.45, q - .07);
    }
    return null;
  } finally { URL.revokeObjectURL(url); }
}
$("file").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f || !cur) return;
  $("shErr").hidden = true; $("photoMsg").textContent = "Saving photo…"; $("photoMsg").hidden = false;
  let data = null; try { data = await shrink(f); } catch (err) { data = null; }
  if (!data) { $("photoMsg").hidden = true; showErr("That file couldn't be used as a photo. Try a JPG or PNG picture."); return; }
  const { wk, k } = cur;
  track(setDoc(doc(db, "photos", wk + "_" + k), { week: wk, key: k, img: data, at: Date.now() }));
  const m = { ...selfOf(wk) }; m[k] = { ...(m[k] || { on: true, at: Date.now() }), photo: true }; SELF[wk] = m;
  render(); fillSheet(); writeSelf(wk);
  $("photo").src = data; $("photo").hidden = false; $("photoMsg").hidden = true;
});
$("rmPhoto").onclick = () => {
  const { wk, k } = cur; const m = { ...selfOf(wk) }; if (!m[k]) return;
  const v = { ...m[k] }; delete v.photo; if (v.on) m[k] = v; else delete m[k]; SELF[wk] = m;
  track(deleteDoc(doc(db, "photos", wk + "_" + k))); writeSelf(wk);
  $("photo").hidden = true; render(); fillSheet();
};
$("sYes").onclick = () => setSelf(true);
$("sNo").onclick = () => setSelf(false);
$("dYes").onclick = () => { dadChoice = "yes"; markDad(); };
$("dNo").onclick = () => { dadChoice = "no"; markDad(); };
$("dSave").onclick = () => {
  const { wk, k } = cur; const items = { ...revOf(wk) }; const note = $("dNote").value.trim();
  const s = selfOf(wk)[k]; const mosheSays = !!(s && s.on); const star = dadChoice === "yes";
  if (star !== mosheSays && !note) { showErr("Add a short reason so Moshe knows why the score changed."); return; }
  items[k] = { star, note, at: Date.now() };
  REVIEW[wk] = items; render(); writeReview(wk); closeSheet();
};
$("dUndo").onclick = () => { const { wk, k } = cur; const items = { ...revOf(wk) }; delete items[k]; REVIEW[wk] = items; render(); writeReview(wk); closeSheet(); };
$("close").onclick = closeSheet;
$("shade").addEventListener("click", e => { if (e.target.id === "shade") closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("shade").hidden) closeSheet(); $("pwShade").hidden = true; } });
document.addEventListener("click", e => { const b = e.target.closest(".cell"); if (!b || b.disabled) return; openSheet(b.dataset.k); });
$("prev").onclick = () => { week = addDays(week, -7); render(); };
$("next").onclick = () => { if (iso(week) < iso(thisMonday)) { week = addDays(week, 7); render(); } };

// keep "today" right if the app stays open overnight
setInterval(() => {
  const m = mondayOf(new Date()), t = (new Date().getDay() + 6) % 7;
  if (iso(m) !== iso(thisMonday) || t !== todayIdx) { const wasCur = iso(week) === iso(thisMonday); thisMonday = m; todayIdx = t; if (wasCur) week = new Date(m); if (who) render(); }
}, 60000);

// ---------- accounts ----------
// Login names map to internal emails stored in meta/login (no real mailbox needed).
async function loadLogin() { const s = await getDoc(doc(db, "meta", "login")); LOGIN = s.exists() ? s.data() : null; return LOGIN; }
// Create a user without signing the current session out (uses a throwaway second app).
async function createSideUser(email, password) {
  const side = initializeApp(firebaseConfig, "side-" + Date.now());
  try { const cred = await createUserWithEmailAndPassword(getAuth(side), email, password); const uid = cred.user.uid; await signOut(getAuth(side)); return uid; }
  finally { await deleteApp(side); }
}
const newMosheEmail = () => `moshe-${Date.now().toString(36)}@${LOGIN_DOMAIN}`;

function showGate(mode, msg) {
  $("app").hidden = true; $("gate").hidden = false;
  $("gLoad").hidden = mode !== "loading"; if (msg) $("gLoadMsg").textContent = msg;
  $("gSetup").hidden = mode !== "setup";
  $("gLogin").hidden = mode !== "login";
  if (mode === "login") setTimeout(() => $("lgPw").focus(), 0);
}
function pick(r) {
  pickedRole = r; $("pickMo").classList.toggle("sel", r === "moshe"); $("pickDad").classList.toggle("sel", r === "dad");
  $("lgLbl").textContent = NAME[r] + "'s password"; $("lgErr").hidden = true; $("lgPw").value = ""; $("lgPw").focus();
}
$("pickMo").onclick = () => pick("moshe");
$("pickDad").onclick = () => pick("dad");

$("gSetup").addEventListener("submit", async e => {
  e.preventDefault();
  const a = $("suDad").value, b = $("suDad2").value, m = $("suMo").value.trim();
  const err = t => { $("suErr").textContent = t; $("suErr").hidden = false; };
  $("suErr").hidden = true;
  if (a.length < 6) return err("Dad's password needs at least 6 characters.");
  if (a !== b) return err("The two Dad passwords don't match.");
  if (m.length < 6) return err("Moshe's password needs at least 6 characters.");
  if (a === m) return err("Use different passwords for Dad and Moshe.");
  $("suBtn").disabled = true; settingUp = true;
  const dadEmail = `dad@${LOGIN_DOMAIN}`;
  try {
    let dadUid;
    try { dadUid = (await createUserWithEmailAndPassword(auth, dadEmail, a)).user.uid; }
    catch (x) { if ((x.code || "").includes("email-already-in-use")) dadUid = (await signInWithEmailAndPassword(auth, dadEmail, a)).user.uid; else throw x; }
    LOGIN = { dad: dadEmail, moshe: newMosheEmail() };
    const mUid = await createSideUser(LOGIN.moshe, m);
    try { await setDoc(doc(db, "meta", "roles"), { dad: dadUid, moshe: mUid }); }
    catch (x) { await updateDoc(doc(db, "meta", "roles"), { moshe: mUid }); } // retry after an interrupted setup
    await setDoc(doc(db, "meta", "login"), LOGIN);
    ["suDad", "suDad2", "suMo"].forEach(i => $(i).value = "");
    await enter(auth.currentUser);
  } catch (x) { err(authMsg(x)); }
  finally { $("suBtn").disabled = false; settingUp = false; }
});

$("gLogin").addEventListener("submit", async e => {
  e.preventDefault();
  const err = t => { $("lgErr").textContent = t; $("lgErr").hidden = false; };
  const pw = $("lgPw").value; if (!pw) return err("Type your password.");
  $("lgBtn").disabled = true;
  try {
    if (!LOGIN) await loadLogin();
    await signInWithEmailAndPassword(auth, LOGIN[pickedRole], pw);
    $("lgPw").value = "";
  } catch (x) { err(authMsg(x)); }
  finally { $("lgBtn").disabled = false; }
});

async function enter(user) {
  let roles;
  try { const s = await getDoc(doc(db, "meta", "roles")); roles = s.exists() ? s.data() : null; }
  catch (x) { roles = null; }
  const r = roles && (user.uid === roles.dad ? "dad" : user.uid === roles.moshe ? "moshe" : null);
  if (!r) { await signOut(auth); showGate("login"); $("lgErr").textContent = "This login isn't active any more. Ask Dad for the new password."; $("lgErr").hidden = false; return; }
  who = r; isDad = r === "dad";
  $("who").textContent = isDad ? "Dad's view · you can review every box" : "Moshe's view";
  $("who").classList.toggle("dad", isDad);
  $("sub").textContent = isDad ? "Tap any box to see Moshe's check and photo, then give your own score." : "Tap a box when you finish a task. Add a photo if you like.";
  $("resetBox").hidden = !isDad;
  week = new Date(thisMonday);
  $("gate").hidden = true; $("app").hidden = false;
  const fail = () => { $("status").textContent = "Live updates stopped. Reload the app."; };
  unsubs.push(onSnapshot(collection(db, "self"), s => {
    const o = {}; s.forEach(d => { const v = d.data(); if (v && v.week) o[v.week] = v.marks || {}; }); SELF = o; render();
    if (cur && !$("shade").hidden && !isDad) fillSheet();
  }, fail));
  unsubs.push(onSnapshot(collection(db, "review"), s => {
    const o = {}; s.forEach(d => { const v = d.data(); if (v && v.week) o[v.week] = v.items || {}; }); REVIEW = o; render();
  }, fail));
  $("status").textContent = "Synced"; render();
}
async function logout() {
  unsubs.forEach(u => u()); unsubs = []; SELF = {}; REVIEW = {};
  closeSheet(); $("pwShade").hidden = true; who = null; isDad = false;
  await signOut(auth);
}
$("outBtn").onclick = logout;

// change own password / reset Moshe's
function pwMsg(id, t) { $("pwErr").hidden = true; $("pwOk").hidden = true; if (t) { $(id).textContent = t; $(id).hidden = false; } }
$("pwBtn").onclick = () => { ["pwOld", "pwNew", "pwNew2", "rsMo"].forEach(i => $(i).value = ""); pwMsg(); $("pwShade").hidden = false; $("pwOld").focus(); };
$("pwClose").onclick = () => { $("pwShade").hidden = true; };
$("pwShade").addEventListener("click", e => { if (e.target.id === "pwShade") $("pwShade").hidden = true; });
$("pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const o = $("pwOld").value, n = $("pwNew").value, n2 = $("pwNew2").value;
  if (n.length < 6) return pwMsg("pwErr", "New password needs at least 6 characters.");
  if (n !== n2) return pwMsg("pwErr", "The new passwords don't match.");
  try {
    const u = auth.currentUser;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, o));
    await updatePassword(u, n);
    ["pwOld", "pwNew", "pwNew2"].forEach(i => $(i).value = "");
    pwMsg("pwOk", "Password changed.");
  } catch (x) { pwMsg("pwErr", (x.code || "").includes("credential") ? "Current password is wrong." : authMsg(x)); }
});
$("rsBtn").onclick = async () => {
  if (!isDad) return;
  const m = $("rsMo").value.trim();
  if (m.length < 6) return pwMsg("pwErr", "Moshe's new password needs at least 6 characters.");
  $("rsBtn").disabled = true;
  try {
    if (!LOGIN) await loadLogin();
    const email = newMosheEmail();
    const uid = await createSideUser(email, m);
    await updateDoc(doc(db, "meta", "roles"), { moshe: uid });
    await setDoc(doc(db, "meta", "login"), { ...LOGIN, moshe: email });
    LOGIN = { ...LOGIN, moshe: email };
    $("rsMo").value = "";
    pwMsg("pwOk", "Moshe's password is reset. He'll need to log in again with the new one.");
  } catch (x) { pwMsg("pwErr", authMsg(x)); }
  finally { $("rsBtn").disabled = false; }
};

// ---------- boot ----------
const setOffline = () => { $("offline").hidden = navigator.onLine; };
addEventListener("online", setOffline); addEventListener("offline", setOffline); setOffline();

onAuthStateChanged(auth, async user => {
  if (user) { if (!who && !settingUp) await enter(user); return; }
  who = null;
  try {
    await loadLogin();
    showGate(LOGIN ? "login" : "setup");
  } catch (x) { showGate("loading", "Can't reach the server. Check your internet and reload."); }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
