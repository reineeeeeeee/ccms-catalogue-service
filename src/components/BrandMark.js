// The PUP seal. The file lives in public/pup-logo.png (served at /pup-logo.png).
export default function BrandMark({ size = 40 }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/pup-logo.png" alt="Polytechnic University of the Philippines seal" width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />
  );
}
