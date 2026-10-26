import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Bot, Cpu, Loader2, MessageSquare, RotateCcw, Sparkles, User } from 'lucide-react';
import type { ChatMessage, ProviderStatus } from '../lib/types';
import { CodeBlock } from './CodeBlock';

interface Props {
  messages: ChatMessage[];
  sending: boolean;
  onSend: (text: string) => void;
  onClear: () => void;
  provider: ProviderStatus | null;
  hasContext: boolean;
}

const QUICK_PROMPTS = [
  'Diagnose this 401 error.',
  'Explain why this OAuth request failed.',
  'Show me the difference between 401 and 403.',
  'Generate a corrected curl command.',
  'What should I check next?',
];

export function AssistantPanel({ messages, sending, onSend, onClear, provider, hasContext }: Props) {
  const [value, setValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  const submit = () => {
    const text = value.trim();
    if (!text || sending) return;
    setValue('');
    onSend(text);
  };

  return (
    <div className="flex h-[68dvh] min-h-0 flex-col xl:h-full">
      <div ref={scrollRef} className="scrollbar-thin flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="animate-fade-up">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/25 bg-accent-soft">
                <Sparkles size={15} className="text-accent" />
              </div>
              <div>
                <p className="text-[13px] font-medium text-fg">Ask about this request</p>
                <p className="text-[10.5px] text-fg-dim">
                  {provider?.mode === 'model' ? `Connected to ${provider.model}` : 'Local assistant · deterministic intents'}
                </p>
              </div>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-fg-muted">
              The assistant can re-run the diagnosis, build a corrected curl command, compare status codes and inspect what was redacted.
              {hasContext ? ' It can see the request currently loaded in the workspace.' : ' Load a request first for context-aware answers.'}
            </p>
            <div className="mt-4 space-y-1.5">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSend(prompt)}
                  className="flex w-full items-center gap-2 rounded-lg border border-line bg-ink-800/60 px-2.5 py-2 text-left text-[11.5px] text-fg-muted transition hover:border-accent/35 hover:bg-ink-800 hover:text-fg"
                >
                  <MessageSquare size={12} className="shrink-0 text-fg-dim" />
                  {prompt}
                </button>
              ))}
            </div>
            <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-line/70 bg-ink-800/30 px-2.5 py-2 text-[10.5px] leading-relaxed text-fg-dim">
              <Cpu size={11} className="mt-0.5 shrink-0" />
              No HTTP requests are executed from this workspace. Answers are advisory and must be reviewed.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div key={message.id} className="animate-fade-up">
                <div className="mb-1 flex items-center gap-1.5">
                  {message.role === 'user' ? (
                    <User size={11} className="text-fg-dim" />
                  ) : (
                    <Bot size={11} className="text-accent" />
                  )}
                  <span className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
                    {message.role === 'user' ? 'You' : 'AuthDoctor'}
                  </span>
                  {message.engine && message.engine !== 'model' && (
                    <span className="rounded border border-line-strong px-1 text-[9px] uppercase tracking-wide text-fg-dim">
                      {message.engine === 'local-fallback' ? 'fallback' : 'local'}
                    </span>
                  )}
                </div>

                {message.role === 'user' ? (
                  <div className="rounded-lg rounded-tl-sm border border-accent/20 bg-accent-soft px-3 py-2 text-[12px] leading-relaxed text-fg">
                    {message.content}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="chat-markdown rounded-lg rounded-tl-sm border border-line bg-ink-800/50 px-3 py-2 text-[12px] leading-relaxed text-fg-muted">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
                          em: ({ children }) => <em className="text-fg-dim">{children}</em>,
                          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>,
                          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>,
                          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                          a: ({ children, href }) => (
                            <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                              {children}
                            </a>
                          ),
                          code: ({ className, children }) => {
                            const isBlock = Boolean(className) || String(children).includes('\n');
                            const language = className?.replace('language-', '') ?? 'text';
                            if (!isBlock) {
                              return <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-fg">{children}</code>;
                            }
                            return (
                              <div className="my-2">
                                <CodeBlock code={String(children).replace(/\n$/, '')} language={language} maxHeight="16rem" wrap />
                              </div>
                            );
                          },
                          pre: ({ children }) => <>{children}</>,
                          table: ({ children }) => (
                            <div className="my-2 overflow-x-auto rounded border border-line">
                              <table className="w-full text-left text-[11px]">{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead className="bg-white/[0.03] text-fg">{children}</thead>,
                          th: ({ children }) => <th className="px-2 py-1.5 font-medium">{children}</th>,
                          td: ({ children }) => <td className="border-t border-line px-2 py-1.5 align-top">{children}</td>,
                          h1: ({ children }) => <h3 className="mb-1 text-[13px] font-semibold text-fg">{children}</h3>,
                          h2: ({ children }) => <h3 className="mb-1 text-[12.5px] font-semibold text-fg">{children}</h3>,
                          h3: ({ children }) => <h3 className="mb-1 text-[12px] font-semibold text-fg">{children}</h3>,
                          hr: () => <hr className="my-2 border-line" />,
                          blockquote: ({ children }) => <blockquote className="border-l-2 border-line-strong pl-2 text-fg-dim">{children}</blockquote>,
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>

                    {message.actions && message.actions.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {message.actions.map((action) => (
                          <span
                            key={`${action.name}-${action.label}`}
                            className="rounded border border-line bg-ink-850 px-1.5 py-0.5 text-[9.5px] text-fg-dim"
                          >
                            {action.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {message.notes && message.notes.length > 0 && (
                      <p className="text-[10px] leading-relaxed text-warn/80">{message.notes.join(' ')}</p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {sending && (
              <div className="flex items-center gap-2 text-[11.5px] text-fg-dim">
                <Loader2 size={12} className="animate-spin text-accent" />
                Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        {messages.length > 0 && (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1 text-[10px] text-fg-dim transition hover:text-fg"
            >
              <RotateCcw size={10} />
              Clear conversation
            </button>
          </div>
        )}
        <div className="relative rounded-lg border border-line bg-ink-900 transition focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-accent/20">
          <textarea
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Ask about this failure…"
            aria-label="Message the assistant"
            className="max-h-32 w-full resize-none bg-transparent px-3 py-2.5 pr-11 text-[12px] leading-relaxed text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || sending}
            className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md bg-accent-strong text-white transition hover:bg-accent disabled:bg-ink-700 disabled:text-fg-dim"
            aria-label="Send message"
          >
            <ArrowUp size={14} />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[9.5px] text-fg-dim">
          Enter to send · Shift+Enter for a new line · no requests are executed
        </p>
      </div>
    </div>
  );
}
