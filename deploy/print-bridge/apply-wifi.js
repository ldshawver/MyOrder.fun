#!/opt/myorder-print-bridge/node/bin/node
/**
 * Join wlan0 to one WPA network, and put the previous network back if the
 * new one does not connect. Run as root. The passphrase is read on stdin
 * and is never written to a log.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");

const CONF = "/etc/wpa_supplicant/wpa_supplicant.conf";
const IFACE = "wlan0";
const WPA_CLI = "/sbin/wpa_cli";
const WPA_PASSPHRASE = "/usr/bin/wpa_passphrase";

function finish(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function fail(error) {
  finish({ success: false, error }, 1);
}

function wifiStatus() {
  const out = execFileSync(WPA_CLI, ["-i", IFACE, "status"], { encoding: "utf8", timeout: 5000 });
  const fields = {};
  for (const line of out.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) fields[line.slice(0, split)] = line.slice(split + 1);
  }
  return fields;
}

function sleep(seconds) {
  execFileSync("sleep", [String(seconds)]);
}

function waitUntil(predicate, seconds) {
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    try {
      if (predicate(wifiStatus())) return true;
    } catch {
      // wpa_cli can miss a beat while the interface reassociates.
    }
    sleep(1);
  }
  return false;
}

function header() {
  const raw = fs.existsSync(CONF) ? fs.readFileSync(CONF, "utf8") : "";
  const country = (raw.match(/^country=([A-Za-z0-9]+)/m) ?? [, "US"])[1];
  return `ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\ncountry=${country}\n\n`;
}

function networkBlock(ssid, password) {
  const generated = execFileSync(WPA_PASSPHRASE, [ssid, password], { encoding: "utf8", timeout: 5000 });
  return `${generated.split("\n").filter(line => !line.includes("#psk=")).join("\n").trim()}\n`;
}

function writeConf(body) {
  const temporary = `${CONF}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, CONF);
  fs.chmodSync(CONF, 0o600);
}

function reconfigure() {
  execFileSync(WPA_CLI, ["-i", IFACE, "reconfigure"], { encoding: "utf8", timeout: 8000 });
}

let request;
try {
  request = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  fail("The Wi-Fi request could not be read.");
}

const ssid = String(request.ssid ?? "").trim();
const password = String(request.password ?? "");
if (!ssid || ssid.length > 32 || /[\u0000-\u001f]/.test(ssid)) fail("Enter a Wi-Fi name up to 32 characters.");
if (password.length < 8 || password.length > 63 || /[\u0000-\u001f]/.test(password)) fail("The Wi-Fi password must be 8 to 63 characters.");

const previous = fs.existsSync(CONF) ? fs.readFileSync(CONF) : Buffer.from("");
let committed = false;
let restoring = false;

function restorePrevious() {
  if (committed || restoring) return;
  restoring = true;
  if (previous.length) fs.writeFileSync(CONF, previous, { mode: 0o600 });
  try { reconfigure(); } catch { /* the restored file is already on disk */ }
  try { waitUntil(current => current.wpa_state === "COMPLETED", 15); } catch { /* keep the restored file */ }
}

// A caller timeout must not leave the new network in place.
process.on("SIGTERM", () => {
  if (committed) finish({ success: true }, 0);
  try { restorePrevious(); } catch { /* keep the restored file */ }
  fail("The Raspberry Pi could not change Wi-Fi, so it returned to the previous network.");
});

try {
  writeConf(header() + networkBlock(ssid, password));
  reconfigure();
  const joined = waitUntil(current => current.wpa_state === "COMPLETED" && current.ssid === ssid, 20);
  if (!joined) {
    restorePrevious();
    fail("The Raspberry Pi could not join that Wi-Fi, so it returned to the previous network.");
  }
  committed = true;
  finish({ success: true }, 0);
} catch {
  try { restorePrevious(); } catch { /* keep the restored file */ }
  fail("The Raspberry Pi could not change Wi-Fi.");
}
