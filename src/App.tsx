import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import Main from './pages/Main';
import { TabProvider } from './components/TabProvider';
import { AppProvider, useAppContext } from './components/AppProvider';
import Settings from './pages/Settings';
import Header from './layout/Header';
import Footer from './layout/Footer';
import Content from './layout/Content';
import { Container } from 'react-bootstrap';

import 'bootstrap/dist/css/bootstrap.min.css';
import './css/interval.scss';

const AppContent = () => {
  const { settingsMode, darkMode } = useAppContext();

  useEffect(() => {
    if (darkMode) {
      document.documentElement.setAttribute("data-bs-theme", "dark");
    }
  }, []);

  return (
    <div onContextMenu={(e) => e.preventDefault()}>
      <Container
        fluid={true}
        className="content"
        {...(darkMode ? { "data-bs-theme": "dark" } : {})}
      >
        <TabProvider>
          <Header />
          <Content>{settingsMode ? <Settings /> : <Main />}</Content>
          <Footer />
        </TabProvider>
      </Container>
    </div>
  );
};

const App = () => {
  return (
    <React.StrictMode>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </React.StrictMode>
  );
};

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(<App />);
