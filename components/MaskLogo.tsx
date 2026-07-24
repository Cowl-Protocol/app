type Props = {
  className?: string;
};

// The Cowl mask mark only (no hood). Uses currentColor so it inherits text color.
export default function MaskLogo({ className }: Props) {
  return (
    <svg
      viewBox="0 0 662 295"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Cowl"
    >
      <path
        d="M661.742 105.229L601.006 245.063L473.178 294.5L331.931 213.283L187.858 293.794L62.1484 245.063L0 105.229L57.9111 0L331.931 105.229L604.537 0L661.742 105.229ZM123.592 192.093L187.859 217.518L274.727 169.494L81.9248 94.6328L123.592 192.093ZM395.492 169.494L482.359 217.518L546.627 192.093L588.294 94.6328L395.492 169.494Z"
        fill="currentColor"
      />
    </svg>
  );
}
