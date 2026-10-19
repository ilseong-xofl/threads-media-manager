import { createRoot } from 'react-dom/client';
import { AuthenticationGate } from './AuthenticationGate';
import { ToastProvider } from './toast';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <AuthenticationGate />
  </ToastProvider>,
);
