import Image from "next/image"

type BezgrowLogoMarkProps = {
  className?: string
  imageClassName?: string
  priority?: boolean
  size?: number
}

export function BezgrowLogoMark({
  className = "",
  imageClassName = "",
  priority = false,
  size = 44,
}: BezgrowLogoMarkProps) {
  return (
    <span
      className={`relative flex shrink-0 overflow-hidden rounded-2xl bg-slate-950 shadow-[0_0_34px_rgba(34,211,238,0.3)] ${className}`}
      aria-hidden="true"
    >
      <Image
        src="/icon-192.png"
        alt=""
        fill
        sizes={`${size}px`}
        className={`object-cover ${imageClassName}`}
        priority={priority}
      />
    </span>
  )
}
