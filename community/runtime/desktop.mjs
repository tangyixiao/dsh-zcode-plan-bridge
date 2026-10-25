/** Desktop integration is disabled until a native model-error plugin hook exists. */
export function createDesktopLaunch(_options, _processes) {
  throw new Error('ZCode Desktop native retry plugin is not implemented. Custom Agent overrides fail independent storage preparation. Use the original ZCode entry point.')
}
