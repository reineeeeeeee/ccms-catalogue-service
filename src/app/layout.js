import './globals.css';
import { BRAND } from '../lib/brand.js';

export const metadata = {
  title: `${BRAND.system} | ${BRAND.campus}`,
  description: "Citizen's Charter Compliance/Monitoring System",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
