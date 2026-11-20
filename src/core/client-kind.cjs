'use strict';
function clientKind(params={}) {
  if(['jetbrains','desktop'].includes(params?._padswitcherClient))return params._padswitcherClient;
  const name=params?.clientInfo?.name;
  // Current extensions send the editor display name; older releases used an originator id.
  if(['codex_vscode','codex_vscode_copilot','VS Code','Cursor','Windsurf'].includes(name))return 'vscode';
  if(['codex_cli_rs','codex_cli'].includes(name))return 'cli';
  return 'other';
}
module.exports={clientKind};
