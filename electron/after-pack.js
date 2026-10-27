/**
 * electron-builder afterPack hook: ad-hoc signs the macOS app before the dmg/zip are made.
 * Without a Developer ID certificate electron-builder skips signing and leaves Electron's
 * original seal broken, so a downloaded build is reported as "damaged". An ad-hoc signature
 * keeps the bundle valid; Gatekeeper still asks the user to allow it once.
 */

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
