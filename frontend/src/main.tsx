import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initSentry, Sentry } from './sentry';

// Fire-and-forget; render immediately rather than waiting on the network.
void initSentry();

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<div style={{padding:24,fontFamily:'system-ui'}}>Algo se rompió. Refrescá la página y avisanos si vuelve a pasar.</div>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>
);
