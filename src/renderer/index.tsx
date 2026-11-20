import { createRoot } from 'react-dom/client';
import { AuthenticationGate } from './AuthenticationGate';
import { ToastProvider } from './toast';
import './styles.css';
// The static <title> cannot carry the variant; the window shows after this runs.
document.title = TMM_DISPLAY_NAME;
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <AuthenticationGate />
  </ToastProvider>,
);
