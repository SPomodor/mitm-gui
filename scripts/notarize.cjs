module.exports = async (context) => {
  if (
    context.electronPlatformName !== "darwin" ||
    process.env.MITM_GUI_NOTARIZE !== "true"
  )
    return;
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ])
    if (!process.env[name]) throw new Error(`Notarization requires ${name}`);
  const appPath = require("node:path").join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  await require("@electron/notarize").notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
