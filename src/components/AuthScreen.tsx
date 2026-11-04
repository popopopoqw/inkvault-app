import { useState } from 'react';
import { useStore } from '../store/app';

function passwordScore(pw: string): number {
  if (pw.length < 8) return 0;
  let kinds = 0;
  if (/[a-z]/.test(pw)) kinds++;
  if (/[A-Z]/.test(pw)) kinds++;
  if (/\d/.test(pw)) kinds++;
  if (/[^a-zA-Z0-9]/.test(pw)) kinds++;
  if (pw.length >= 12 && kinds >= 3) return 4;
  return Math.min(kinds, 3);
}

const STRENGTH_LABEL = ['太短', '弱', '一般', '强', '很强'];
const STRENGTH_COLOR = ['#e5484d', '#e5484d', '#f5a524', '#30a46c', '#30a46c'];

export function AuthScreen({ mode }: { mode: 'setup' | 'login' }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const setup = useStore((s) => s.setup);
  const login = useStore((s) => s.login);
  const busy = useStore((s) => s.authBusy);
  const error = useStore((s) => s.authError);

  const score = passwordScore(password);
  const isSetup = mode === 'setup';
  const canSubmit =
    password.length > 0 && !busy && (!isSetup || (score >= 2 && password === confirm));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (isSetup) await setup(password);
    else await login(password);
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-logo">✍️</div>
        <h1>Markdown 编辑器</h1>
        <p className="auth-sub">
          {isSetup ? '首次使用，请设置一个强密码' : '输入密码解锁你的加密文档库'}
        </p>

        <label className="auth-field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? '至少 8 位，建议混合字母、数字、符号' : '你的密码'}
            autoFocus
            autoComplete={isSetup ? 'new-password' : 'current-password'}
          />
        </label>

        {isSetup && (
          <>
            <div className="strength">
              <div className="strength-bar">
                <div
                  className="strength-fill"
                  style={{ width: `${(score / 4) * 100}%`, background: STRENGTH_COLOR[score] }}
                />
              </div>
              <span style={{ color: STRENGTH_COLOR[score] }}>{STRENGTH_LABEL[score]}</span>
            </div>
            <label className="auth-field">
              <span>确认密码</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {confirm.length > 0 && password !== confirm && <p className="auth-hint error">两次输入不一致</p>}
            <p className="auth-hint warn">
              ⚠️ 端到端加密：密码即密钥，服务器无法找回。忘记密码 = 文档永久无法解密，请务必记牢。
            </p>
          </>
        )}

        {error && <p className="auth-hint error">{error}</p>}

        <button type="submit" disabled={!canSubmit}>
          {busy ? '处理中…' : isSetup ? '创建加密文档库' : '解锁'}
        </button>
      </form>
    </div>
  );
}
