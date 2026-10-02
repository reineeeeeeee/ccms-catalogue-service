import { BRAND } from '../lib/brand.js';
import { pageHref } from '../lib/client/links.js';
import BrandMark from './BrandMark.js';

// Header for the public (no login) pages.
export default function PublicHeader({ overlay = false }) {
  return (
    <header className={overlay ? 'absolute inset-x-0 top-0 z-10 text-white' : 'bg-maroon-900 text-white'}>
      <div className={`mx-auto flex items-center justify-between gap-3 px-4 py-4 ${overlay ? 'max-w-6xl' : 'max-w-5xl'}`}>
        <a href="/" className="flex items-center gap-3">
          <BrandMark size={40} />
          <div>
            <p className="text-sm font-bold leading-tight">{BRAND.campus}</p>
            <p className="text-xs text-white/70">{BRAND.system}</p>
          </div>
        </a>
        <a href={pageHref('/login')} className="rounded-md border border-gold-500 px-4 py-2 text-sm font-semibold text-gold-400 hover:bg-white/10">
          Staff Login
        </a>
      </div>
    </header>
  );
}
