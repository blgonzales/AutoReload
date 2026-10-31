import {
  convertIntervalToTimeoutInterval,
  getDefaultIdleTimeoutSettings,
} from '../src/common';

jest.mock('../src/config', () => ({
  isDebugModeEnabled: () => false,
  isVerboseModeEnabled: () => false,
}));

describe('idle timeout choices', () => {
  test('offers Never (zero) as the last choice and keeps the timed ones', () => {
    const choices = getDefaultIdleTimeoutSettings();
    expect(choices[0].value).toBe(3600000);
    expect(choices.length).toBe(16);
    const never = choices[choices.length - 1];
    expect(never.value).toBe(0);
    expect(convertIntervalToTimeoutInterval(never)).toBe(0);
  });

  test('values are unique so the select can tell them apart', () => {
    const values = getDefaultIdleTimeoutSettings().map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
