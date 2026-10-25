/** The incompatible external desktop launcher stays disabled. */
export function createDesktopLaunch(_options, _processes) {
  throw new Error('External desktop launcher withdrawn: custom Agent overrides fail independent storage preparation. Use the original ZCode entry point and enable Community Retry inside ZCode plugin management.')
}
