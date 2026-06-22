import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import { getSeoLandingPage, seoLandingPages } from "@/lib/seo-pages"

const siteUrl = "https://www.bezgrow.com"

type SeoPageProps = {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return seoLandingPages.map((page) => ({ slug: page.slug }))
}

export async function generateMetadata({ params }: SeoPageProps): Promise<Metadata> {
  const { slug } = await params
  const page = getSeoLandingPage(slug)

  if (!page) {
    return {}
  }

  const url = `${siteUrl}/${page.slug}`

  return {
    title: page.metaTitle,
    description: page.metaDescription,
    keywords: [
      page.primaryKeyword,
      "Bezgrow",
      "inventory management software",
      "GST billing software",
      "ERP software",
      "retail POS software",
      "business management software",
    ],
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: page.metaTitle,
      description: page.metaDescription,
      url,
      siteName: "Bezgrow",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: page.metaTitle,
      description: page.metaDescription,
    },
    robots: {
      index: true,
      follow: true,
    },
  }
}

export default async function SeoLandingPage({ params }: SeoPageProps) {
  const { slug } = await params
  const page = getSeoLandingPage(slug)

  if (!page) notFound()

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  }

  const softwareSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Bezgrow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: `${siteUrl}/${page.slug}`,
    description: page.metaDescription,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "INR",
    },
    publisher: {
      "@type": "Organization",
      name: "Bezgrow",
      url: siteUrl,
    },
  }

  return (
    <main className="min-h-dvh overflow-hidden bg-[#020403] text-white">
      <div className="inventory-grid-bg fixed inset-0 opacity-45" />
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-5 lg:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label="Bezgrow home">
          <BezgrowLogoMark className="h-11 w-11" size={44} />
          <span>
            <span className="block text-lg font-black">Bezgrow</span>
            <span className="block text-xs uppercase tracking-[0.18em] text-white/45">Business Cloud</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2 py-2 md:flex" aria-label="SEO page navigation">
          <Link href="/inventory" className="rounded-full px-4 py-2 text-sm font-bold text-white/70 hover:text-white">Inventory</Link>
          <Link href="/billing" className="rounded-full px-4 py-2 text-sm font-bold text-white/70 hover:text-white">Billing</Link>
          <Link href="/pos" className="rounded-full px-4 py-2 text-sm font-bold text-white/70 hover:text-white">POS</Link>
          <Link href="/erp" className="rounded-full px-4 py-2 text-sm font-bold text-white/70 hover:text-white">ERP</Link>
        </nav>
        <Link href="/signup" className="rounded-2xl bg-white px-5 py-3 text-sm font-black text-black hover:bg-cyan-100">
          Start
        </Link>
      </header>

      <article className="relative z-10">
        <section className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-14 lg:grid-cols-[1.08fr_0.92fr] lg:px-8 lg:py-20">
          <div>
            <p className="inline-flex rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-cyan-100">
              {page.eyebrow}
            </p>
            <h1 className="mt-6 text-4xl font-black leading-[0.98] sm:text-6xl lg:text-7xl">{page.title}</h1>
            <p className="mt-6 max-w-3xl text-lg leading-8 text-white/62">{page.summary}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className="rounded-2xl bg-cyan-300 px-7 py-4 text-center font-black text-black shadow-[0_0_44px_rgba(34,211,238,0.25)] hover:bg-cyan-200">
                Create Workspace
              </Link>
              <Link href="/login" className="rounded-2xl border border-white/12 bg-white/[0.04] px-7 py-4 text-center font-bold text-white/85 hover:border-white/30">
                Login
              </Link>
            </div>
          </div>

          <aside className="rounded-[28px] border border-white/10 bg-white/[0.045] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-100">Best for</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {page.useCases.map((useCase) => (
                <div key={useCase} className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4 text-sm font-bold text-white/80">
                  {useCase}
                </div>
              ))}
            </div>
          </aside>
        </section>

        <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-16 lg:grid-cols-2 lg:px-8">
          {page.sections.map((section) => (
            <section key={section.heading} className="rounded-[28px] border border-white/10 bg-white/[0.035] p-7">
              <h2 className="text-3xl font-black">{section.heading}</h2>
              <p className="mt-4 leading-8 text-white/58">{section.body}</p>
            </section>
          ))}
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-16 lg:px-8">
          <div className="rounded-[30px] border border-cyan-300/20 bg-cyan-300/[0.06] p-7">
            <h2 className="text-3xl font-black">Why Choose Bezgrow</h2>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {page.benefits.map((benefit) => (
                <div key={benefit} className="rounded-2xl border border-white/10 bg-black/25 px-4 py-4 text-sm font-bold text-white/80">
                  {benefit}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-16 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div className="rounded-[28px] border border-white/10 bg-white/[0.035] p-7">
            <h2 className="text-3xl font-black">Related Bezgrow Software Pages</h2>
            <div className="mt-5 grid gap-2">
              {seoLandingPages
                .filter((item) => item.slug !== page.slug)
                .slice(0, 9)
                .map((item) => (
                  <Link key={item.slug} href={`/${item.slug}`} className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm font-bold text-white/75 hover:border-cyan-300/30 hover:text-white">
                    {item.primaryKeyword}
                  </Link>
                ))}
            </div>
          </div>

          <section className="rounded-[28px] border border-white/10 bg-white/[0.035] p-7">
            <h2 className="text-3xl font-black">Frequently Asked Questions</h2>
            <div className="mt-5 grid gap-4">
              {page.faqs.map((faq) => (
                <section key={faq.question} className="rounded-2xl border border-white/10 bg-black/25 p-5">
                  <h3 className="text-xl font-black">{faq.question}</h3>
                  <p className="mt-3 leading-7 text-white/58">{faq.answer}</p>
                </section>
              ))}
            </div>
          </section>
        </section>
      </article>

      <footer className="relative z-10 border-t border-white/10 px-4 py-8 text-center text-sm text-white/45">
        <Link href="/" className="font-bold text-cyan-100">Bezgrow</Link> helps businesses manage inventory, GST billing, POS, customers, and ERP workflows.
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareSchema).replace(/</g, "\\u003c") }}
      />
    </main>
  )
}
