import { useState } from 'react';
import { useUser, useClerk } from '@clerk/clerk-react';
import {
  Feather,
  Zap,
  Shield,
  Globe,
  Check,
  ArrowRight,
  X,
  BookOpen,
  Briefcase,
  Pen,
  Users,
  ChevronDown,
  ChevronUp,
  FileText,
  Lock,
  HelpCircle,
  MessageSquare,
  Clock,
  TrendingUp,
  AlertCircle,
  Crown,
  PenTool,
} from 'lucide-react';

interface LandingPageProps {
  onStartFree: () => void;
  onGoToApp?: () => void;
}

const plans = [
  {
    name: 'Free',
    price: '0',
    description: 'Try IdiomOptima with no commitment',
    features: [
      'Free to use with daily request limits',
      'Academic, Business, Literary & General registers',
      'American, British, Canadian & Australian English',
      'Word, PDF & Plain Text export',
      'Basic diagnostics',
      'Standard processing speed',
    ],
    cta: 'Start Free',
    highlighted: false,
    icon: Zap,
  },
  {
    name: 'Pro',
    price: '9',
    description: 'For writers, researchers, and professionals',
    features: [
      'Everything in Free, plus:',
      'Higher usage limits',
      'Priority processing',
      'Longer document support (up to 4,000 words)',
    ],
    cta: 'Coming Soon',
    highlighted: true,
    icon: Crown,
  },
  {
    name: 'Enterprise',
    price: '49',
    description: 'For teams and organizations',
    features: [
      'Everything in Pro, plus:',
      'Unlimited usage',
      'API access',
      'Custom lexicon integration',
    ],
    cta: 'Coming Soon',
    highlighted: false,
    icon: Shield,
  },
];

const faqs = [
  {
    q: 'Does it change my writing style?',
    a: "No. IdiomOptima fixes grammar, punctuation, and awkward phrasing while preserving your natural rhythm, word choices, and sentence structure. It's designed to make your writing sound like you, just polished.",
  },
  {
    q: 'How does dialect detection work?',
    a: "IdiomOptima detects the dialect in your text and lets you choose a target dialect (American, British, Canadian, or Australian English). It then applies the correct spelling and lexical conventions for your chosen dialect.",
  },
  {
    q: 'Can I undo changes?',
    a: 'Yes. Every transformation shows a side-by-side comparison of each sentence. You can see exactly what changed and why, then apply or discard the full result.',
  },
  {
    q: 'Is my text stored on your servers?',
    a: "No. Your text is processed in memory and never stored. We don't use your writing to train models or for any other purpose. Your words stay yours.",
  },
  {
    q: 'How is this different from Grammarly?',
    a: "Grammarly focuses on correctness. IdiomOptima focuses on authenticity. We fix the same errors, but we also detect and replace AI-sounding phrases, apply regional dialect conventions, and preserve your authorial voice. Think of it as a language editor, not just a grammar checker.",
  },
];

const registers = [
  {
    name: 'Academic',
    icon: BookOpen,
    color: 'from-indigo-500 to-purple-500',
    bgLight: 'bg-indigo-500/10',
    description: 'Formal precision for papers, theses, and research',
    example: 'Maintains citations, technical terminology, and formal structure',
  },
  {
    name: 'Business',
    icon: Briefcase,
    color: 'from-sky-500 to-blue-500',
    bgLight: 'bg-sky-500/10',
    description: 'Clear, professional communication',
    example: 'Optimizes for clarity, directness, and corporate tone',
  },
  {
    name: 'Literary',
    icon: Pen,
    color: 'from-rose-500 to-pink-500',
    bgLight: 'bg-rose-500/10',
    description: 'Voice-first editing for fiction and essays',
    example: 'Minimal intervention, preserves rhythm and style',
  },
  {
    name: 'General',
    icon: Users,
    color: 'from-emerald-500 to-teal-500',
    bgLight: 'bg-emerald-500/10',
    description: 'Everyday writing, emails, and messages',
    example: 'Natural corrections without over-formalizing',
  },
];

const steps = [
  {
    number: '01',
    title: 'Paste or Write',
    description: 'Add your text to the editor. Any length, any dialect.',
    icon: FileText,
  },
  {
    number: '02',
    title: 'Choose Your Mode',
    description: 'Select your register (Academic, Business, Literary, General) and target dialect.',
    icon: Globe,
  },
  {
    number: '03',
    title: 'Nativize',
    description: 'Click Nativize. Our engine analyzes every sentence, corrects errors, and preserves your voice.',
    icon: PenTool,
  },
];

const beforeAfterExamples = [
  {
    original: 'The data indicates that there is a significant correlation between the variables that were examined in the study.',
    refined: 'The data shows a significant correlation between the examined variables.',
    label: 'Conciseness',
    mode: 'Academic',
  },
  {
    original: 'I wanted to reach out to touch base regarding the deliverables that are due by end of day Friday.',
    refined: "I'm following up on the deliverables due by Friday.",
    label: 'Professionalism',
    mode: 'Business',
  },
  {
    original: 'The rain fell softly, it reminded her of childhood summers spent at her grandmother\'s house.',
    refined: "The rain fell softly; it reminded her of childhood summers spent at her grandmother's house.",
    label: 'Voice Preservation',
    mode: 'Literary',
  },
];

const testimonials = [
  {
    text: 'IdiomOptima caught regional phrasing I did not realize was non-standard. My British editor stopped flagging my submissions.',
    author: 'PhD Researcher',
    field: 'Computational Biology',
  },
  {
    text: 'I run everything through IdiomOptima before sending client proposals. It tightens my prose without making it sound robotic.',
    author: 'Marketing Director',
    field: 'SaaS Startup',
  },
  {
    text: "Finally, an editor that does not strip my voice. It fixes what needs fixing and leaves the rest alone. That is rare.",
    author: 'Published Author',
    field: 'Literary Fiction',
  },
];

export default function LandingPage({ onStartFree, onGoToApp }: LandingPageProps) {
  const { isSignedIn } = useUser();
  const { openSignIn, openSignUp } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [activeExample, setActiveExample] = useState(0);
  const [policyModal, setPolicyModal] = useState<'terms' | 'privacy' | null>(null);

  return (
    <div className="min-h-screen bg-[#0B1120] text-white font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0B1120]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-lg flex items-center justify-center">
              <Feather className="w-4 h-4 text-white" />
            </div>
            <span className="font-serif text-xl font-bold tracking-tight">IdiomOptima</span>
          </a>

          <nav className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-slate-400 hover:text-white transition-colors">Features</a>
            <a href="#how-it-works" className="text-sm text-slate-400 hover:text-white transition-colors">How It Works</a>
            <a href="#pricing" className="text-sm text-slate-400 hover:text-white transition-colors">Pricing</a>
            <a href="#faq" className="text-sm text-slate-400 hover:text-white transition-colors">FAQ</a>
          </nav>

          <div className="flex items-center gap-3">
            {isSignedIn ? (
              <button
                onClick={() => onGoToApp?.()}
                className="hidden md:block px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm font-semibold rounded-full hover:from-indigo-600 hover:to-purple-600 transition-all"
              >
                Open App
              </button>
            ) : (
              <>
                <button
                  onClick={() => openSignIn()}
                  className="hidden md:block text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Log In
                </button>
                <button
                  onClick={() => onStartFree()}
                  className="hidden md:block px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm font-semibold rounded-full hover:from-indigo-600 hover:to-purple-600 transition-all"
                >
                  Start Free
                </button>
              </>
            )}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-slate-400 hover:text-white"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/5 bg-[#0B1120] px-6 py-4 space-y-3">
            <a href="#features" className="block text-sm text-slate-400 hover:text-white" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a href="#how-it-works" className="block text-sm text-slate-400 hover:text-white" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
            <a href="#pricing" className="block text-sm text-slate-400 hover:text-white" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
            <a href="#faq" className="block text-sm text-slate-400 hover:text-white" onClick={() => setMobileMenuOpen(false)}>FAQ</a>
            <hr className="border-white/10" />
            {isSignedIn ? (
              <button onClick={() => { onGoToApp?.(); setMobileMenuOpen(false); }} className="block w-full text-center px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm font-semibold rounded-full">Open App</button>
            ) : (
              <>
                <button onClick={() => { openSignIn(); setMobileMenuOpen(false); }} className="block text-sm text-slate-400 hover:text-white">Log In</button>
                <button onClick={() => { onStartFree(); setMobileMenuOpen(false); }} className="block w-full text-center px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm font-semibold rounded-full">Start Free</button>
              </>
            )}
          </div>
        )}
      </header>

      {/* Hero */}
      <section className="pt-32 pb-20 px-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 via-transparent to-transparent" />
        <div className="max-w-4xl mx-auto text-center relative">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-full text-xs text-indigo-400 font-medium mb-6">
            <Zap className="w-3 h-3" />
            Voice-preserving text refinement
          </div>
          <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-[1.1] tracking-tight">
            <span className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
              Your words, perfected.
            </span>
          </h1>
          <p className="text-lg md:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            IdiomOptima corrects grammar, eliminates awkward phrasing, and applies
            your chosen dialect, all while keeping your natural voice intact.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onStartFree}
              className="px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-semibold rounded-full hover:from-indigo-600 hover:to-purple-600 transition-all shadow-lg shadow-indigo-500/25 flex items-center gap-2"
            >
              Start Editing Free
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="px-8 py-3.5 bg-white/5 text-white font-semibold rounded-full hover:bg-white/10 transition-all border border-white/10"
            >
              See How It Works
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-4">No account required. Free to use.</p>
        </div>
      </section>

      {/* Problem Section */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Most editors fix mistakes. We preserve intent.
              </span>
            </h2>
            <p className="text-slate-400 max-w-2xl mx-auto">
              Generic grammar tools flatten your voice into corporate English.
              IdiomOptima understands that how you say something matters as much as what you say.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
              <div className="w-10 h-10 bg-red-500/10 rounded-xl flex items-center justify-center mb-4">
                <AlertCircle className="w-5 h-5 text-red-400" />
              </div>
              <h3 className="font-semibold mb-2">Generic Tools</h3>
              <p className="text-sm text-slate-400">They correct grammar but strip your dialect, rhythm, and personality.</p>
            </div>
            <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
              <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center mb-4">
                <Clock className="w-5 h-5 text-amber-400" />
              </div>
              <h3 className="font-semibold mb-2">Manual Editing</h3>
              <p className="text-sm text-slate-400">You spend hours second-guessing phrasing and hunting for inconsistencies.</p>
            </div>
            <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
              <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center mb-4">
                <TrendingUp className="w-5 h-5 text-indigo-400" />
              </div>
              <h3 className="font-semibold mb-2">IdiomOptima</h3>
              <p className="text-sm text-slate-400">Corrects errors, applies your dialect, and keeps your voice unmistakably yours.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Registers Section */}
      <section id="features" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Four registers. One engine.
              </span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto">
              Whether you are writing a dissertation, a pitch deck, or a novel,
              IdiomOptima adapts to your register without losing your voice.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {registers.map((reg) => {
              const Icon = reg.icon;
              return (
                <div
                  key={reg.name}
                  className="p-5 bg-white/[0.02] border border-white/5 rounded-2xl hover:bg-white/[0.04] transition-colors"
                >
                  <div className={`w-10 h-10 ${reg.bgLight} rounded-xl flex items-center justify-center mb-3`}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="font-semibold mb-1">{reg.name}</h3>
                  <p className="text-xs text-slate-400 mb-2">{reg.description}</p>
                  <p className="text-[11px] text-slate-500 italic">{reg.example}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Three steps. That is it.
              </span>
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.number} className="text-center">
                  <div className="w-14 h-14 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Icon className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div className="text-xs text-indigo-400 font-bold tracking-widest mb-2">{step.number}</div>
                  <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
                  <p className="text-sm text-slate-400">{step.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Before/After */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                See the difference
              </span>
            </h2>
            <p className="text-slate-400">Real examples from real text. No cherry-picking.</p>
          </div>
          <div className="flex justify-center gap-2 mb-8">
            {beforeAfterExamples.map((ex, i) => (
              <button
                key={i}
                onClick={() => setActiveExample(i)}
                className={`px-4 py-2 text-xs font-semibold rounded-full transition-all ${
                  activeExample === i
                    ? 'bg-indigo-500 text-white'
                    : 'bg-white/5 text-slate-400 hover:bg-white/10'
                }`}
              >
                {ex.label}
              </button>
            ))}
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="p-5 bg-red-500/5 border border-red-500/10 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] font-bold tracking-widest text-red-400 uppercase">Original</span>
                <span className="text-[10px] px-2 py-0.5 bg-white/5 rounded-full text-slate-500">{beforeAfterExamples[activeExample].mode}</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{beforeAfterExamples[activeExample].original}</p>
            </div>
            <div className="p-5 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] font-bold tracking-widest text-emerald-400 uppercase">Refined</span>
                <Check className="w-3 h-3 text-emerald-400" />
              </div>
              <p className="text-sm text-slate-200 leading-relaxed">{beforeAfterExamples[activeExample].refined}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.map((t, i) => (
              <div key={i} className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
                <p className="text-sm text-slate-300 leading-relaxed mb-4 italic">"{t.text}"</p>
                <div>
                  <p className="text-sm font-semibold">{t.author}</p>
                  <p className="text-xs text-slate-500">{t.field}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Simple pricing
              </span>
            </h2>
            <p className="text-slate-400">Start free. Upgrade when you need more.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((plan) => {
              const Icon = plan.icon;
              return (
                <div
                  key={plan.name}
                  className={`p-6 rounded-2xl border transition-all ${
                    plan.highlighted
                      ? 'bg-gradient-to-b from-indigo-500/10 to-purple-500/10 border-indigo-500/30 shadow-lg shadow-indigo-500/10'
                      : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-4">
                    <Icon className={`w-5 h-5 ${plan.highlighted ? 'text-indigo-400' : 'text-slate-400'}`} />
                    <h3 className="font-semibold">{plan.name}</h3>
                  </div>
                  <div className="mb-4">
                    <span className="text-4xl font-bold">${plan.price}</span>
                    <span className="text-slate-500 text-sm">/month</span>
                  </div>
                  <p className="text-sm text-slate-400 mb-6">{plan.description}</p>
                  <ul className="space-y-2.5 mb-6">
                    {plan.features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                        <Check className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => {
                      if (plan.name === 'Enterprise') {
                        window.location.href = 'mailto:contact@idiomoptima.com';
                      } else if (plan.name === 'Free') {
                        onStartFree();
                      }
                    }}
                    className={`w-full py-2.5 rounded-full text-sm font-semibold transition-all ${
                      plan.highlighted
                        ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 shadow-lg shadow-indigo-500/25'
                        : 'bg-white/5 text-white border border-white/10 hover:bg-white/10'
                    } ${plan.cta === 'Coming Soon' ? 'opacity-60 cursor-default' : ''}`}
                  >
                    {plan.cta}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Frequently asked questions
              </span>
            </h2>
          </div>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <div key={i} className="border border-white/5 rounded-2xl overflow-hidden">
                <button
                  onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                  className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors"
                >
                  <span className="font-medium text-sm pr-4">{faq.q}</span>
                  {expandedFaq === i ? (
                    <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                </button>
                {expandedFaq === i && (
                  <div className="px-6 pb-4">
                    <p className="text-sm text-slate-400 leading-relaxed">{faq.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
              Ready to write like yourself?
            </span>
          </h2>
          <p className="text-slate-400 mb-8 max-w-lg mx-auto">
            Join thousands of writers, researchers, and professionals who trust IdiomOptima to preserve their voice.
          </p>
          <button
            onClick={onStartFree}
            className="px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-semibold rounded-full hover:from-indigo-600 hover:to-purple-600 transition-all shadow-lg shadow-indigo-500/25 inline-flex items-center gap-2"
          >
            Start Editing Free
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* TOS Acceptance */}
      <div className="border-t border-white/5 py-4 px-6">
        <p className="text-center text-[11px] text-slate-500 max-w-xl mx-auto leading-relaxed">
          By using IdiomOptima, you agree to our{" "}
          <button onClick={() => setPolicyModal('terms')} className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors">Terms of Service</button>
          {" "}and{" "}
          <button onClick={() => setPolicyModal('privacy')} className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors">Privacy Policy</button>.
        </p>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-md flex items-center justify-center">
              <Feather className="w-3 h-3 text-white" />
            </div>
            <span className="font-serif text-sm font-bold">IdiomOptima</span>
            <span className="text-xs text-slate-500">&copy; {new Date().getFullYear()}</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-slate-500">
            <button onClick={() => setPolicyModal('terms')} className="hover:text-white transition-colors flex items-center gap-1">
              <FileText className="w-3 h-3" /> Terms
            </button>
            <button onClick={() => setPolicyModal('privacy')} className="hover:text-white transition-colors flex items-center gap-1">
              <Lock className="w-3 h-3" /> Privacy
            </button>
            <a href="/faq.html" className="hover:text-white transition-colors flex items-center gap-1">
              <HelpCircle className="w-3 h-3" /> FAQ
            </a>
            <a href="mailto:contact@idiomoptima.com" className="hover:text-white transition-colors flex items-center gap-1">
              <MessageSquare className="w-3 h-3" /> Contact
            </a>
          </div>
        </div>
      </footer>

      {/* Policy Modal */}
      {policyModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={() => setPolicyModal(null)}>
          <div className="bg-[#111827] border border-white/10 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-8 relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPolicyModal(null)} className="absolute top-4 right-4 text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
            <h3 className="text-xl font-bold mb-4">{policyModal === 'terms' ? 'Terms of Service' : 'Privacy Policy'}</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              {policyModal === 'terms'
                ? 'By using IdiomOptima, you agree to use the service for lawful purposes. We reserve the right to modify or discontinue the service at any time. Your use of the service is at your own risk.'
                : 'We respect your privacy. IdiomOptima processes your text in memory and does not store it on our servers. We do not sell your data or use it for advertising. We may collect anonymous usage analytics to improve the service.'}
            </p>
            <p className="text-xs text-slate-500 mt-4">
              Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}