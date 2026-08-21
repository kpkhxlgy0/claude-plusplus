export interface TweakCommandOutput {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleTweakCommandOutput: TweakCommandOutput = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
