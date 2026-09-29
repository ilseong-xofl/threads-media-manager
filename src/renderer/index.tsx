import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './toast';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
