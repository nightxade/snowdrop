import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createHearth, HearthProvider } from '@/app';
import '@/ui/styles/global.css';

const hearth = createHearth({ document });
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <HearthProvider hearth={hearth}>
      <App />
    </HearthProvider>
  </StrictMode>,
);

hearth.start().catch((error: unknown) => {
  console.error('[hearth] failed to start', error);
});
