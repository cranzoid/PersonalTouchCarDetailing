import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#061A2C] px-5 py-16 text-center text-white">
      <div className="max-w-lg">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#E0A93B] text-sm font-black text-[#0B2A4A]">PT</span>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.24em] text-[#EDC66F]">Page not found</p>
        <h1 className="mt-4 font-display text-5xl leading-tight">This route needs a course correction.</h1>
        <p className="mt-5 leading-7 text-[#B9C7D2]">The link may have expired, moved, or never existed. Return home or open the service menu to keep exploring.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#E0A93B] px-6 py-3 text-sm font-semibold text-[#0B2A4A]">Return home</Link>
          <Link href="/services" className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/25 px-6 py-3 text-sm font-semibold text-white">View services</Link>
        </div>
      </div>
    </main>
  );
}
