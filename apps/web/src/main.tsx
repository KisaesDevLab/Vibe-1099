import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import { DialogProvider } from './components/Dialogs';
import { AppErrorBoundary, RouteErrorBoundary } from './components/ErrorBoundary';
import { StaffShell } from './staff/Shell';
import { Login } from './staff/Login';
import { ResetPassword } from './staff/ResetPassword';
import { Dashboard } from './staff/Dashboard';
import { Fleet } from './staff/Fleet';
import { Inbox } from './staff/Inbox';
import { Payers } from './staff/Payers';
import { Recipients } from './staff/Recipients';
import { FormsGrid } from './staff/FormsGrid';
import { ReviewQueue } from './staff/ReviewQueue';
import { Invites } from './staff/Invites';
import { W9Dashboard } from './staff/W9Dashboard';
import { Batches } from './staff/Batches';
import { Deliveries } from './staff/Deliveries';
import { Transmissions } from './staff/Transmissions';
import { FilingStatus } from './staff/FilingStatus';
import { MoFiles } from './staff/MoFiles';
import { Corrections } from './staff/Corrections';
import { MO_FILING_ENABLED } from './config';
import { Settings } from './staff/Settings';
import { ClientPortal } from './portal/ClientPortal';
import { RecipientPortal } from './portal/RecipientPortal';
import { W9Portal } from './portal/W9Portal';

// errorElement on every route: a render fault shows a recoverable panel instead
// of a blank page with a stack trace.
const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <RouteErrorBoundary /> },
  { path: '/reset-password', element: <ResetPassword />, errorElement: <RouteErrorBoundary /> },
  // public zones
  { path: '/client', element: <ClientPortal />, errorElement: <RouteErrorBoundary /> },
  { path: '/f/:token', element: <RecipientPortal />, errorElement: <RouteErrorBoundary /> },
  { path: '/w9/:token', element: <W9Portal />, errorElement: <RouteErrorBoundary /> },
  // staff zone — child errorElements keep the shell (nav) mounted
  {
    path: '/',
    element: <StaffShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Dashboard />, errorElement: <RouteErrorBoundary /> },
      { path: 'inbox', element: <Inbox />, errorElement: <RouteErrorBoundary /> },
      { path: 'fleet', element: <Fleet />, errorElement: <RouteErrorBoundary /> },
      { path: 'payers', element: <Payers />, errorElement: <RouteErrorBoundary /> },
      { path: 'recipients', element: <Recipients />, errorElement: <RouteErrorBoundary /> },
      { path: 'forms', element: <FormsGrid />, errorElement: <RouteErrorBoundary /> },
      { path: 'review', element: <ReviewQueue />, errorElement: <RouteErrorBoundary /> },
      { path: 'invites', element: <Invites />, errorElement: <RouteErrorBoundary /> },
      { path: 'w9', element: <W9Dashboard />, errorElement: <RouteErrorBoundary /> },
      { path: 'batches', element: <Batches />, errorElement: <RouteErrorBoundary /> },
      { path: 'deliveries', element: <Deliveries />, errorElement: <RouteErrorBoundary /> },
      { path: 'transmissions', element: <Transmissions />, errorElement: <RouteErrorBoundary /> },
      { path: 'filing-status', element: <FilingStatus />, errorElement: <RouteErrorBoundary /> },
      ...(MO_FILING_ENABLED ? [{ path: 'missouri', element: <MoFiles />, errorElement: <RouteErrorBoundary /> }] : []),
      { path: 'corrections', element: <Corrections />, errorElement: <RouteErrorBoundary /> },
      { path: 'settings', element: <Settings />, errorElement: <RouteErrorBoundary /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <DialogProvider>
        <RouterProvider router={router} />
      </DialogProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
