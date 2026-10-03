export type ReactGrabDevEnv = {
  readonly dev: boolean
  readonly enableFlag?: string
}

export function shouldEnableReactGrab(env: ReactGrabDevEnv): boolean {
  return env.dev && env.enableFlag === 'true'
}
