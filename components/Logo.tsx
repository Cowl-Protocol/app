type Props = {
  className?: string;
};

export default function Logo({ className }: Props) {
  return (
    <svg
      viewBox="0 0 768 872"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Cowl"
    >
      <path
        d="M383 0C447.667 25 591.2 114.4 648 272C704.8 429.6 751.333 557.667 767.5 602L484 871.5L383.5 752L282 871.5L0 600.5L125.5 255.5C149 199.5 193.5 85.5 383 0ZM384 156C284.5 209.5 172.5 258 84 540.5L276 737.5L384 624.5L494 737.5L684.5 540.5C625.5 380.5 583 254 384 156ZM618.5 443.5L575.5 542.5L485 577.5L385 520L283 577L194 542.5L150 443.5L191 369L385 443.5L578 369L618.5 443.5ZM237.5 505L283 523L344.5 489L208 436L237.5 505ZM430 489L491.5 523L537 505L566.5 436L430 489Z"
        fill="currentColor"
      />
    </svg>
  );
}
