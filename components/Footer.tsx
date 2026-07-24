import MaskLogo from "./MaskLogo";

export default function Footer() {
  return (
    <footer className="px-6 md:px-10 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-faint">
      <span className="flex items-center gap-2 label-mono text-[0.62rem]">
        <MaskLogo className="h-2.5 w-auto text-acid" />
        © Cowl Protocol
      </span>
      <div className="flex items-center gap-5">
        <a href="https://cowlprotocol.com" className="label-mono text-[0.62rem] hover:text-bone transition-colors">
          Home
        </a>
        <a href="https://cowlprotocol.com/docs" className="label-mono text-[0.62rem] hover:text-bone transition-colors">
          Docs
        </a>
        <a
          href="https://github.com/Cowl-Protocol"
          className="label-mono text-[0.62rem] hover:text-bone transition-colors"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
