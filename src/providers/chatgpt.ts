import { parseAIResponse } from '../core/json-parser';
import type { AuthStatus, ProviderResponse, Question } from '../types';
import { createGroupedTab } from '../utils/tab-group';
import { BaseProvider } from './base-provider';

export class ChatGPTProvider extends BaseProvider {
  async checkAuth(): Promise<AuthStatus> {
    const base = await super.checkAuth();
    if (base === 'authenticated') return base;

    const tabId = await this.findProviderTab(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    if (tabId === undefined) return 'unauthenticated';

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: chatgptAuthProbe,
      });
      return results[0]?.result === true ? 'authenticated' : 'unauthenticated';
    } catch {
      return 'unauthenticated';
    }
  }

  async query(questions: Question[]): Promise<ProviderResponse> {
    try {
      const prompt = this.buildPrompt(questions);
      const tabId = await this.ensureChatGPTTab();
      // Use the visible composer to send into the existing conversation.
      return await this.queryViaDom(prompt, tabId);
    } catch (error) {
      return {
        providerId: this.config.id,
        answers: [],
        rawText: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async queryViaDom  private async queryViaDom(prompt: string, tabId: number): Promise<ProviderResponse> {
    const sendResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: chatgptDomSend,
      args: [prompt],
    });

    const sendResult = sendResults[0]?.result as { ok: boolean; error?: string } | undefined;
    if (!sendResult?.ok) {
      return {
        providerId: this.config.id,
        answers: [],
        rawText: '',
        error: `ChatGPT DOM: ${sendResult?.error ?? '无法发送消息'}`,
      };
    }

    const MAX_WAIT_MS = 90_000;
    const POLL_INTERVAL_MS = 2_000;
    let lastText = '';
    let stableCount = 0;

    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += POLL_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollResults = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: chatgptDomPoll,
      });

      const poll = pollResults[0]?.result as { text: string; isStreaming: boolean } | undefined;
      if (!poll) continue;

      if (poll.text && poll.text !== lastText) {
        lastText = poll.text;
        stableCount = 0;
      } else if (poll.text) {
        stableCount++;
        if (!poll.isStreaming && stableCount >= 2) break;
      }
    }

    if (!lastText) {
      return {
        providerId: this.config.id,
        answers: [],
        rawText: '',
        error: 'ChatGPT DOM: 90s 内未检测到回复',
      };
    }

    const parsed = parseAIResponse(lastText, this.config.id);
    return { ...parsed, rawText: lastText };
  }

  private async ensureChatGPTTab(): Promise<number> {
    // Prefer the focused ChatGPT tab to preserve the current conversation.
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const active = activeTabs.find((tab) => {
      if (!tab.url || tab.id === undefined) return false;
      try {
        const host = new URL(tab.url).hostname;
        return host === 'chatgpt.com' || host === 'chat.openai.com';
      } catch {
        return false;
      }
    });
    if (active?.id !== undefined) return active.id;

    for (const pattern of ['https://chatgpt.com/*', 'https://chat.openai.com/*']) {
      const tabs = await chrome.tabs.query({ url: pattern });
      const tab = tabs.find((item) => item.id !== undefined);
      if (tab?.id !== undefined) return tab.id;
    }

    const tab = await createGroupedTab({ url: 'https://chatgpt.com/', active: true });
    if (tab.id === undefined) throw new Error('ChatGPT: chrome.tabs.create 无 id');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('ChatGPT: tab 加载超时'));
      }, 20_000);
      function listener(id: number, info: chrome.tabs.TabChangeInfo) {
        if (id === tab.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    return tab.id;
  }
}

// ---------------------------------------------------------------------------
// These functions run inside chatgpt.com MAIN world via executeScript.
// They must be self-contained because Chrome serializes them into the page.
// ---------------------------------------------------------------------------

async function chatgptDomSend(message: string): Promise<{ ok: boolean; error?: string }> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value: string): string =>
    value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ];

  try {
    let inputEl: HTMLElement | null = null;
    for (const selector of selectors) {
      const candidates = document.querySelectorAll<HTMLElement>(selector);
      inputEl = Array.from(candidates).find((el) => el.getClientRects().length > 0) ?? null;
      if (inputEl) break;
    }
    if (!inputEl) return { ok: false, error: '找不到当前会话输入框，请先打开 ChatGPT 对话页面' };

    const beforeCount = document.querySelectorAll('[data-message-author-role="user"]').length;
    inputEl.focus();

    if (inputEl instanceof HTMLTextAreaElement || inputEl instanceof HTMLInputElement) {
      const proto = inputEl instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return { ok: false, error: '无法更新 ChatGPT 输入框' };
      setter.call(inputEl, message);
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Use the editing command so React receives the contenteditable input event path.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand('insertText', false, message);
      if (!inserted || normalize(inputEl.innerText || inputEl.textContent || '') !== normalize(message)) {
        inputEl.replaceChildren(document.createTextNode(message));
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      }
    }

    const sendSelectors = [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'form button[type="submit"]',
      'button[type="submit"]',
    ];
    let sendButton: HTMLButtonElement | null = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      for (const selector of sendSelectors) {
        const candidates = document.querySelectorAll<HTMLButtonElement>(selector);
        sendButton = Array.from(candidates).find((button) =>
          button.getClientRects().length > 0 &&
          !button.disabled &&
          button.getAttribute('aria-disabled') !== 'true',
        ) ?? null;
        if (sendButton) break;
      }
      if (sendButton) break;
      await sleep(150);
    }

    const pressEnter = (): void => {
      inputEl?.focus();
      inputEl?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      inputEl?.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    };

    if (sendButton) sendButton.click();
    else pressEnter();

    const hasNewUserTurn = (): boolean => {
      const turns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'));
      if (turns.length > beforeCount) return true;
      const prefix = normalize(message.slice(0, 80));
      return !!prefix && turns.some((turn) =>
        normalize(turn.innerText || turn.textContent || '').includes(prefix),
      );
    };

    const waitForTurn = async (timeout: number): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (hasNewUserTurn()) return true;
        await sleep(250);
      }
      return false;
    };

    let sent = await waitForTurn(8_000);
    if (!sent && sendButton) {
      pressEnter();
      sent = await waitForTurn(8_000);
    }

    if (!sent) {
      return {
        ok: false,
        error: '题目已填入输入框，但没有检测到新消息进入当前会话；本次不会误报发送成功。',
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function chatgptDomPoll(): { text: string; isStreaming: boolean } {
  const clean = (t: string): string => t.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  const scope = document.querySelector('main') ?? document.body;
  const selectors = [
    'div[data-message-author-role="assistant"]',
    '.agent-turn [data-message-author-role="assistant"]',
  ];
  const inConversationTurn = (el: Element): boolean =>
    !!el.closest('[data-testid^="conversation-turn"], [data-testid*="conversation"], .agent-turn');

  let text = '';
  for (const sel of selectors) {
    const els = scope.querySelectorAll(sel);
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els.item(i);
      if (!el) continue;
      if (!inConversationTurn(el)) continue;
      const t = clean((el as HTMLElement).textContent ?? '');
      if (t.length >= 10) {
        text = t;
        break;
      }
    }
    if (text) break;
  }

  const stopBtn = document.querySelector(
    'button.bg-black .icon-lg, [aria-label*="Stop"], [aria-label*="stop"]',
  );
  const isStreaming = !!stopBtn;

  return { text, isStreaming };
}

function chatgptAuthProbe(): Promise<boolean> {
  return fetch('/api/auth/session', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: Record<string, unknown> | null) => !!d?.accessToken)
    .catch(() => false);
}
