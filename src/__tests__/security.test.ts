import { describe, it, expect } from 'vitest';
import { touchesSecretPath } from '../sdkSession';
import { redactSecrets } from '../deviceActions';

describe('touchesSecretPath — test-session secret deny-list', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['Read', { file_path: '/home/jeroen/VScode workspace for building nostr apps/kubo/android/key.properties' }, true],
    ['Read', { file_path: 'codedeck/src-tauri/gen/android/keystore.properties' }, true],
    ['Read', { file_path: 'kubo/android/app/kubo-release.keystore' }, true],
    ['Bash', { command: 'cat codedeck/src-tauri/gen/android/codedeck-release.p12 | base64' }, true],
    ['Grep', { pattern: 'storePassword', path: 'kubo/android/key.properties' }, true],
    ['Read', { file_path: '.env.zapstore' }, true],
    ['Read', { file_path: 'codedeck/.env.local' }, true],
    ['Bash', { command: 'keytool -list -keystore foo.jks' }, true],
    // benign — must NOT be blocked
    ['Read', { file_path: 'kubo/src/components/App.tsx' }, false],
    ['Bash', { command: 'npm run build' }, false],
    ['Read', { file_path: 'codedeck/package.json' }, false],
    // a tool that doesn't bear paths is never blocked even if text mentions a keystore
    ['AskUserQuestion', { questions: [{ question: 'open the keystore?' }] }, false],
  ];
  for (const [tool, input, expected] of cases) {
    it(`${tool} ${JSON.stringify(input).slice(0, 50)} -> ${expected ? 'BLOCKED' : 'allowed'}`, () => {
      expect(touchesSecretPath(tool, input)).toBe(expected);
    });
  }
});

describe('redactSecrets — logcat/output scrubbing', () => {
  it('redacts bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123_XYZ')).not.toContain('abc.def-123_XYZ');
  });
  it('redacts JWTs', () => {
    expect(redactSecrets('token eyJhbGciOiJIUzI1NiIsdummysignature')).toContain('[REDACTED_JWT]');
  });
  it('redacts nostr nsec', () => {
    expect(redactSecrets('key=nsec1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8q')).toContain('[REDACTED_NSEC]');
  });
  it('redacts password/token kv', () => {
    const out = redactSecrets('storePassword=hunter2 apiKey: sk-abc123');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('sk-abc123');
  });
  it('redacts long hex blobs', () => {
    expect(redactSecrets('priv c1cf657c71ce41b45f2c4f323f688cd9f01b8c2ddc2b3a05bfab4007c40a6bdc')).toContain('[REDACTED_HEX]');
  });
  it('leaves benign log lines intact', () => {
    const line = 'D/MainActivity: onCreate took 42ms';
    expect(redactSecrets(line)).toBe(line);
  });
});
