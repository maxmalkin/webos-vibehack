// Decides when LG's home should be sent back to the launcher, from foreground-app changes alone
// (webOS reports which app is in front, not key presses).
//
// LG's home comes up -> open the launcher. Press Home again within escapeMs of the launcher
// reappearing -> stay on LG's home, for its menus.
module.exports = function homeRedirect(launcher, lgHome, escapeMs) {
  var redirecting = false, backAt = -Infinity;
  return function shouldOpenLauncher(app, now) {
    if (!app) return false;                     // '' between apps
    if (app === launcher) {
      if (redirecting) backAt = now;
      redirecting = false;
      return false;
    }
    if (app !== lgHome) { redirecting = false; return false; }
    if (now - backAt < escapeMs) { backAt = -Infinity; return false; }
    redirecting = true;
    return true;
  };
};
