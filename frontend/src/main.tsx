import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from '@/features/auth/AuthContext';
import { TeamsProvider } from '@/features/teams/TeamsContext';
import { router } from '@/app/router';
import { adoptServerHolidays, adoptServerWeekend } from '@/lib/calendar';
import { adoptServerScheduling } from '@/lib/scheduling';
import { fetchSystemInfo } from '@/features/system/api';
import './index.css';

// v1.11: pull the instance-wide weekend convention (Sat/Sun vs Thu/Fri)
// at boot and adopt it into lib/calendar.ts so the date picker's mapDays
// callback colours the right cells red. Best-effort — a 5xx leaves the
// default (SAT_SUN) in place and the app still works.
void fetchSystemInfo()
  .then((info) => {
    adoptServerWeekend(info.calendarWeekend);
    adoptServerHolidays(info.calendarHolidays);
    adoptServerScheduling(info);
  })
  .catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TeamsProvider>
          <RouterProvider router={router} />
        </TeamsProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
