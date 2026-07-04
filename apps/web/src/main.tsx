import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import { DialogProvider } from './components/Dialogs';
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

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/reset-password', element: <ResetPassword /> },
  // public zones
  { path: '/client', element: <ClientPortal /> },
  { path: '/f/:token', element: <RecipientPortal /> },
  { path: '/w9/:token', element: <W9Portal /> },
  // staff zone
  {
    path: '/',
    element: <StaffShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'inbox', element: <Inbox /> },
      { path: 'fleet', element: <Fleet /> },
      { path: 'payers', element: <Payers /> },
      { path: 'recipients', element: <Recipients /> },
      { path: 'forms', element: <FormsGrid /> },
      { path: 'review', element: <ReviewQueue /> },
      { path: 'invites', element: <Invites /> },
      { path: 'w9', element: <W9Dashboard /> },
      { path: 'batches', element: <Batches /> },
      { path: 'deliveries', element: <Deliveries /> },
      { path: 'transmissions', element: <Transmissions /> },
      { path: 'filing-status', element: <FilingStatus /> },
      ...(MO_FILING_ENABLED ? [{ path: 'missouri', element: <MoFiles /> }] : []),
      { path: 'corrections', element: <Corrections /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DialogProvider>
      <RouterProvider router={router} />
    </DialogProvider>
  </React.StrictMode>,
);
