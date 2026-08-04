import MaskLogo from "./MaskLogo";
import SignNotice from "./SignNotice";

export default function Footer() {
  return (
    <footer className="px-6 md:px-10 py-6 text-faint">
      {/* Every page, not just the ones with an unlock button: the signature is
          asked for lazily, as a step inside a send or a trade, so there is no
          single screen where the rule would always be in view. */}
      <div className="pb-4 flex justify-center sm:justify-start">
        <SignNotice compact />
      </div>
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <span className="flex items-center gap-2 label-mono text-[0.62rem]">
          <MaskLogo className="h-2.5 w-auto text-acid" />
          © Cowl Protocol
          {/* Marked because this moves real money on mainnet while it is still
              young. Someone deciding how much to put in deserves to know that
              before they find out from a rough edge. */}
          <span className="text-acid px-1.5 py-0.5 bg-[#161a10]">Beta</span>
        </span>
        <div className="flex items-center gap-5">
          <a href="https://cowlprotocol.com" className="label-mono text-[0.62rem] hover:text-bone transition-colors">
            Home
          </a>
          <a
            href="https://cowlprotocol.com/docs"
            className="label-mono text-[0.62rem] hover:text-bone transition-colors"
          >
            Docs
          </a>
          <a
            href="https://github.com/Cowl-Protocol"
            className="label-mono text-[0.62rem] hover:text-bone transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
