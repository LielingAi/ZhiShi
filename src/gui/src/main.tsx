import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

// 渲染期异常兜底：直接上屏（含 React 组件栈）——白屏/黑屏时能看到
// 真实出错组件，不用开 DevTools。
class StartupErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null; stack: string }> {
  state = { err: null as Error | null, stack: '' };

  static getDerivedStateFromError(err: Error) {
    return { err, stack: '' };
  }

  componentDidCatch(err: Error, info: { componentStack?: string }) {
    this.setState({ err, stack: info.componentStack ?? '' });
  }

  render() {
    const { err, stack } = this.state;
    if (!err) return this.props.children;
    return (
      <pre
        style={{
          color: '#e5534b',
          font: '13px/1.6 Consolas,monospace',
          padding: 16,
          whiteSpace: 'pre-wrap',
          background: '#0b0e13',
        }}
      >
        {`[render error] ${err.message}\n\n${stack}`}
      </pre>
    );
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root');

createRoot(rootEl).render(
  <StrictMode>
    <StartupErrorBoundary>
      <App />
    </StartupErrorBoundary>
  </StrictMode>,
);
