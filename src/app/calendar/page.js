'use client';

import { useState } from 'react';
import { ROLES } from 'ccms-shared/roles';
import AppShell from '../../components/AppShell.js';
import Holidays from './Holidays.js';
import SyncPanel from './SyncPanel.js';
import Terms from './Terms.js';
import WorkingHours from './WorkingHours.js';

const TABS = [
  { id: 'hours', label: 'Working hours' },
  { id: 'holidays', label: 'Holidays & suspensions' },
  { id: 'terms', label: 'Academic terms' },
];

function CalendarManager({ user }) {
  const canWrite = user.role === ROLES.SUPER_ADMIN;
  const [tab, setTab] = useState('hours');
  const [syncKey, setSyncKey] = useState(0);
  const changed = () => setSyncKey((k) => k + 1);

  return (
    <div className="space-y-4">
      {canWrite ? <SyncPanel refreshKey={syncKey} /> : null}
      <div role="tablist" aria-label="Calendar sections" className="flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-4 px-4 py-2 text-sm font-semibold ${tab === t.id ? 'border-gold-500 text-maroon-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'hours' ? <WorkingHours canWrite={canWrite} onChanged={changed} /> : null}
        {tab === 'holidays' ? <Holidays canWrite={canWrite} onChanged={changed} /> : null}
        {tab === 'terms' ? <Terms canWrite={canWrite} onChanged={changed} /> : null}
      </div>
    </div>
  );
}

export default function CalendarPage() {
  return (
    <AppShell title="Calendar" subtitle="Working hours, holidays, suspensions and academic terms (Asia/Manila).">
      {(user) => <CalendarManager user={user} />}
    </AppShell>
  );
}
