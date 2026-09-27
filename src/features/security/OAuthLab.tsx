import { useMemo, useRef, useState } from 'react';
import { StepForward } from 'lucide-react';
import {
  ArchNode,
  DiagramCanvas,
  NodeStatRow,
  ParticleLegend,
  type DiagramEdge,
  type EdgeTone,
  type Layout,
  type ParticleView,
} from '@/components/architecture';
import { Insight, LabShell, MetricsPanel } from '@/components/learning';
import { Badge, Button, Select, Toggle } from '@/components/ui';
import { useEventLog, useTicker, type EventTone } from '@/simulations/engine';
import { useRerender } from '@/hooks/useRerender';
import { cn } from '@/utils/cn';
import type { NodeStatus, RequestOutcome } from '@/types';
import { useLabRunning } from '@/hooks/useLabRunning';

/*
 * The authorization code flow with PKCE, one HTTP message at a time, between
 * the four OAuth parties - plus an attacker when the learner picks an attack.
 *
 * It is a script, not a protocol implementation: each setup produces a fixed
 * list of messages. The values on the wire are the example values from
 * RFC 6749 and RFC 7636 (code, state, code_verifier, code_challenge, tokens),
 * and the token lifetime is an example, not what any real server must use.
 */

type Party = 'user' | 'app' | 'auth' | 'res' | 'attacker';
type Attack = 'none' | 'stolen-code' | 'redirect' | 'csrf';
type Scope = 'photos.read' | 'photos.read photos.write';
type ApiCall = 'read' | 'delete';

interface Setup {
  attack: Attack;
  pkce: boolean;
  stateCheck: boolean;
  exactRedirect: boolean;
  scope: Scope;
  call: ApiCall;
}

const DEFAULT_SETUP: Setup = {
  attack: 'none',
  pkce: true,
  stateCheck: true,
  exactRedirect: true,
  scope: 'photos.read',
  call: 'read',
};

const ATTACKS: { value: Attack; label: string; blurb: string }[] = [
  { value: 'none', label: 'No attack', blurb: 'The honest flow: the user signs in and the app calls the API.' },
  { value: 'stolen-code', label: 'Stolen authorization code', blurb: 'A malicious app catches the redirect.' },
  { value: 'redirect', label: 'Tampered redirect_uri', blurb: 'A phishing link sends the code elsewhere.' },
  { value: 'csrf', label: 'Forged callback (CSRF)', blurb: 'The victim browser delivers the attacker code.' },
];

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'photos.read', label: 'photos.read' },
  { value: 'photos.read photos.write', label: 'photos.read photos.write' },
];

const CALLS: { value: ApiCall; label: string }[] = [
  { value: 'read', label: 'GET /photos (needs photos.read)' },
  { value: 'delete', label: 'DELETE /photos/7 (needs photos.write)' },
];

// Example values from RFC 6749 (code, state, tokens) and RFC 7636 appendix B (PKCE).
const APP = 'https://printapp.example';
const REDIRECT = `${APP}/cb`;
const EVIL_REDIRECT = 'https://printapp.example.attacker.test/cb';
const STATE = 'xyz';
const CODE = 'SplxlOBeZQQYbYS6WxSbIA';
const ATTACKER_CODE = 'Qm8vTzL2rWc4NxY1bKd7Aa';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ACCESS_TOKEN = '2YotnFZFEjr1zCsicMWpAA';
const REFRESH_TOKEN = 'tGzv3JOkF0XG5Qx2TlKWIA';
/** Tokens for the account the attacker controls (the access token is the RFC 6750 example). */
const ATTACKER_ACCESS_TOKEN = 'mF_9.B5f-4.1JqM';
const ATTACKER_REFRESH_TOKEN = 'Hk3pQ9vLx2Rt7WcZ0bNm4A';
/** Example access token lifetime in seconds - a common choice, not a rule. */
const TOKEN_LIFETIME_S = 3600;

interface Step {
  from: Party;
  to: Party;
  /** Short caption shown above the canvas and in the step list. */
  title: string;
  /** The HTTP message on the wire, fixed-width. */
  wire: string;
  /** What to notice about this hop. */
  note: string;
  outcome: RequestOutcome;
}

type Verdict = 'ok' | 'denied' | 'blocked' | 'breached';

interface Run {
  steps: Step[];
  verdict: Verdict;
  /** The defence that stopped the attack, or the check that refused the call. */
  stoppedBy?: string;
  /** The party that said no, when one did. */
  rejectedBy?: Party;
  headline: string;
  summary: string;
}

const authorizeQuery = (setup: Setup, redirect: string, challenge: string | null, state: string | null) =>
  [
    'GET /authorize?response_type=code',
    '  &client_id=printapp',
    `  &redirect_uri=${redirect}`,
    `  &scope=${setup.scope.replace(' ', '%20')}`,
    state ? `  &state=${state}` : null,
    challenge ? `  &code_challenge=${challenge}` : null,
    challenge ? '  &code_challenge_method=S256' : null,
  ]
    .filter(Boolean)
    .join('\n');

const tokenRequest = (code: string, redirect: string, verifier: string | null) =>
  [
    'POST /token',
    'grant_type=authorization_code',
    `code=${code}`,
    `redirect_uri=${redirect}`,
    'client_id=printapp',
    verifier ? `code_verifier=${verifier}` : null,
  ]
    .filter(Boolean)
    .join('\n');

const tokenResponse = (scope: Scope, access = ACCESS_TOKEN, refresh = REFRESH_TOKEN) =>
  [
    '200 OK',
    '{',
    `  "access_token": "${access}",`,
    '  "token_type": "Bearer",',
    `  "expires_in": ${TOKEN_LIFETIME_S},`,
    `  "refresh_token": "${refresh}",`,
    `  "scope": "${scope}"`,
    '}',
  ].join('\n');

const LEAK: Step[] = [
  {
    from: 'attacker',
    to: 'res',
    title: 'Attacker calls the API',
    wire: `GET /photos\nAuthorization: Bearer ${ACCESS_TOKEN}`,
    note: 'The resource server checks the token and its scope. It cannot tell who is holding it - a bearer token works for whoever has it.',
    outcome: 'warning',
  },
  {
    from: 'res',
    to: 'attacker',
    title: 'Victim photos leak',
    wire: '200 OK\n[ 42 photos of the victim ]',
    note: 'The attack worked. Every check the resource server makes passed, because the token is genuine.',
    outcome: 'warning',
  },
];

/** The messages one setup produces, and how the run ends. */
function buildRun(setup: Setup): Run {
  const { attack, pkce, stateCheck, exactRedirect, scope, call } = setup;
  const state = stateCheck ? STATE : null;
  const challenge = pkce ? CHALLENGE : null;

  const signIn: Step = {
    from: 'user',
    to: 'app',
    title: 'User clicks Sign in',
    wire: `GET ${APP}/login`,
    note: 'The user wants the print app to read their photos, which live at another company.',
    outcome: 'success',
  };
  const toAuthorize: Step = {
    from: 'app',
    to: 'user',
    title: 'Redirect to /authorize',
    wire: `302 Found\nLocation: https://auth.example${authorizeQuery(setup, REDIRECT, challenge, state).replace('GET ', '')}`,
    note: pkce
      ? 'The app made a random code_verifier and keeps it. Only its SHA-256 hash, the code_challenge, goes into the link.'
      : 'PKCE is off: nothing in the link ties the coming code to this copy of the app.',
    outcome: 'success',
  };
  const openAuthorize: Step = {
    from: 'user',
    to: 'auth',
    title: 'Browser opens /authorize',
    wire: authorizeQuery(setup, REDIRECT, challenge, state),
    note: exactRedirect
      ? 'The authorization server compares redirect_uri with the registered one, character for character. They match.'
      : 'The authorization server only checks that redirect_uri starts with the registered origin. It passes.',
    outcome: 'success',
  };
  const login: Step = {
    from: 'user',
    to: 'auth',
    title: 'Password and consent go here',
    wire: `POST /login\nusername=ana&password=********\n\nPOST /consent\nscope=${scope}&approve=yes`,
    note: 'The password is typed at the authorization server. The client app never sees it - that is the whole point of OAuth.',
    outcome: 'success',
  };
  const codeBack: Step = {
    from: 'auth',
    to: 'user',
    title: 'Redirect back with a code',
    wire: `302 Found\nLocation: ${REDIRECT}?code=${CODE}${state ? `&state=${state}` : ''}`,
    note: 'The code is single use and short lived - RFC 6749 recommends 10 minutes at most. It is not a token yet.',
    outcome: 'success',
  };

  if (attack === 'stolen-code') {
    const steps: Step[] = [
      signIn,
      toAuthorize,
      openAuthorize,
      login,
      codeBack,
      {
        from: 'user',
        to: 'attacker',
        title: 'Malicious app catches the code',
        wire: `GET /cb?code=${CODE}${state ? `&state=${state}` : ''}\n(delivered to the malicious app)`,
        note: 'On a phone, a malicious app registered for the same redirect scheme can receive the redirect instead of the real app (RFC 7636, section 1). The state value is correct - it was in the same URL.',
        outcome: 'warning',
      },
      {
        from: 'attacker',
        to: 'auth',
        title: 'Attacker redeems the code',
        wire: tokenRequest(CODE, REDIRECT, null),
        note: 'The client is a public client - an app on a phone cannot keep a secret - so client_id is public. The attacker has the code but not the code_verifier, which never left the real app.',
        outcome: 'warning',
      },
    ];
    if (pkce) {
      steps.push({
        from: 'auth',
        to: 'attacker',
        title: 'Rejected: no code_verifier',
        wire: '400 Bad Request\n{ "error": "invalid_grant" }',
        note: 'The server stored the code_challenge with this code. No verifier hashes to it, so the code is worthless to the attacker.',
        outcome: 'failure',
      });
      return {
        steps,
        verdict: 'blocked',
        stoppedBy: 'PKCE',
        rejectedBy: 'auth',
        headline: 'Blocked by PKCE',
        summary:
          'The attacker had the code and even the right state, and still got nothing: redeeming a code needs the code_verifier, and only the app that started the flow has it. The state check could not help here - state protects the callback, not the code.',
      };
    }
    steps.push(
      {
        from: 'auth',
        to: 'attacker',
        title: 'Tokens issued to the attacker',
        wire: tokenResponse(scope),
        note: 'Without PKCE, a code plus the public client_id is all a public client needs. The server has no way to tell the attacker from the real app.',
        outcome: 'warning',
      },
      ...LEAK,
    );
    return {
      steps,
      verdict: 'breached',
      headline: 'The stolen code worked',
      summary:
        'Without PKCE the code alone was enough to get tokens. The state check passed too, because the state came in the same stolen URL. Turn PKCE on and replay: the same stolen code is rejected at the token endpoint.',
    };
  }

  if (attack === 'redirect') {
    const phishing: Step = {
      from: 'attacker',
      to: 'user',
      title: 'Phishing link, evil redirect_uri',
      wire: authorizeQuery(setup, EVIL_REDIRECT, pkce ? 'attackers-own-challenge' : null, state ? 'attackers-state' : null).replace(
        'GET ',
        'https://auth.example',
      ),
      note: 'A real client_id and a real consent screen, but the redirect_uri points at the attacker. The attacker built the link, so any PKCE challenge in it belongs to the attacker.',
      outcome: 'warning',
    };
    const opened: Step = {
      from: 'user',
      to: 'auth',
      title: 'Victim opens the link',
      wire: `GET /authorize?client_id=printapp\n  &redirect_uri=${EVIL_REDIRECT}\n  &...`,
      note: `Registered redirect URI: ${REDIRECT}. The one in the link only starts with the same characters.`,
      outcome: 'success',
    };
    if (exactRedirect) {
      return {
        steps: [
          phishing,
          opened,
          {
            from: 'auth',
            to: 'user',
            title: 'Rejected: redirect_uri not registered',
            wire: '400 Bad Request\ninvalid redirect_uri\n(error page shown, no redirect)',
            note: 'An exact string comparison fails, so the server shows an error to the user and sends the browser nowhere.',
            outcome: 'failure',
          },
        ],
        verdict: 'blocked',
        stoppedBy: 'exact redirect URI match',
        rejectedBy: 'auth',
        headline: 'Blocked by exact redirect URI matching',
        summary:
          'The authorization server compared the redirect_uri with the registered one character for character, so the code was never created. PKCE could not have stopped this one: the attacker started the flow, so the attacker holds the matching verifier.',
      };
    }
    return {
      steps: [
        phishing,
        opened,
        { ...login, title: 'Victim signs in and consents', note: 'Everything looks genuine: the real sign-in page and the real app name on the consent screen.' },
        {
          from: 'auth',
          to: 'user',
          title: 'Code sent to attacker domain',
          wire: `302 Found\nLocation: ${EVIL_REDIRECT}?code=${CODE}`,
          note: 'The loose check let the attacker URI through, so the server redirects the code to it.',
          outcome: 'warning',
        },
        {
          from: 'user',
          to: 'attacker',
          title: 'Code lands at the attacker',
          wire: `GET /cb?code=${CODE}`,
          note: 'The victim browser follows the redirect and hands the code to the attacker server.',
          outcome: 'warning',
        },
        {
          from: 'attacker',
          to: 'auth',
          title: 'Attacker redeems the code',
          wire: tokenRequest(CODE, EVIL_REDIRECT, pkce ? 'attackers-own-verifier' : null),
          note: pkce
            ? 'PKCE passes: the attacker made the challenge, so the attacker verifier matches it. PKCE proves the redeemer started the flow - here the attacker did.'
            : 'No PKCE and a public client: the code alone is enough.',
          outcome: 'warning',
        },
        {
          from: 'auth',
          to: 'attacker',
          title: 'Tokens issued to the attacker',
          wire: tokenResponse(scope),
          note: 'The redirect_uri in this request matches the one in the authorization request, so the server issues tokens.',
          outcome: 'warning',
        },
        ...LEAK,
      ],
      verdict: 'breached',
      headline: 'The code went to the attacker',
      summary: pkce
        ? 'PKCE was on and did not help: the attacker started this flow, so the attacker holds the verifier. The defence here is the authorization server comparing redirect_uri exactly. Turn it on and replay.'
        : 'A loose redirect check sent the code to the attacker. Turning on PKCE would not stop this - the attacker would start the flow with its own verifier. Turn on exact redirect URI matching and replay.',
    };
  }

  if (attack === 'csrf') {
    const planted: Step = {
      from: 'attacker',
      to: 'user',
      title: 'Link carrying the attacker code',
      wire: `${REDIRECT}?code=${ATTACKER_CODE}`,
      note: 'The attacker ran the flow for an account the attacker controls and stopped before redeeming the code. Now the victim is tricked into opening the callback with it.',
      outcome: 'warning',
    };
    const callback: Step = {
      from: 'user',
      to: 'app',
      title: 'Victim browser hits the callback',
      wire: `GET /cb?code=${ATTACKER_CODE}\n(no state, or not the one stored for this browser)`,
      note: 'The request comes from the real browser of the victim, with the victim cookies.',
      outcome: 'warning',
    };
    if (stateCheck) {
      return {
        steps: [
          planted,
          callback,
          {
            from: 'app',
            to: 'user',
            title: 'Rejected: state does not match',
            wire: '400 Bad Request\nstate missing or not the one stored for this browser',
            note: 'The app only accepts a callback carrying the state it stored for this browser before the redirect.',
            outcome: 'failure',
          },
        ],
        verdict: 'blocked',
        stoppedBy: 'state',
        rejectedBy: 'app',
        headline: 'Blocked by the state check',
        summary:
          'The callback did not carry the state this browser was given, so the app refused it before redeeming anything. PKCE also stops this attack on its own - turn state off and replay to see it.',
      };
    }
    if (pkce) {
      return {
        steps: [
          planted,
          callback,
          {
            from: 'app',
            to: 'auth',
            title: 'Code plus this session verifier',
            wire: tokenRequest(ATTACKER_CODE, REDIRECT, '<verifier of this browser session>'),
            note: 'The attacker code is bound to the attacker challenge. Whatever verifier this browser session holds - if it holds one at all - does not hash to it.',
            outcome: 'success',
          },
          {
            from: 'auth',
            to: 'app',
            title: 'Rejected: verifier does not match',
            wire: '400 Bad Request\n{ "error": "invalid_grant" }',
            note: 'The code and the verifier come from two different flows, so the server refuses.',
            outcome: 'failure',
          },
        ],
        verdict: 'blocked',
        stoppedBy: 'PKCE',
        rejectedBy: 'auth',
        headline: 'Blocked by PKCE',
        summary:
          'No state check, but the code was bound to a different flow, so the token endpoint refused it. RFC 9700 lets a client rely on PKCE for this CSRF protection once it knows the server enforces PKCE.',
      };
    }
    return {
      steps: [
        planted,
        callback,
        {
          from: 'app',
          to: 'auth',
          title: 'App redeems the attacker code',
          wire: tokenRequest(ATTACKER_CODE, REDIRECT, null),
          note: 'Nothing tells the app that this browser never started a flow.',
          outcome: 'success',
        },
        {
          from: 'auth',
          to: 'app',
          title: 'Tokens for the attacker account',
          wire: tokenResponse(scope, ATTACKER_ACCESS_TOKEN, ATTACKER_REFRESH_TOKEN),
          note: 'Valid tokens - for the account the attacker controls, not for the victim. The app now ties them to the browser session of the victim.',
          outcome: 'success',
        },
        {
          from: 'app',
          to: 'user',
          title: 'Victim linked to attacker account',
          wire: '302 Found\nLocation: /prints\n(session signed in to the attacker account)',
          note: 'The victim sees a normal print app page. Nothing says the account is not theirs.',
          outcome: 'warning',
        },
        {
          from: 'user',
          to: 'app',
          title: 'Victim saves card and address',
          wire: 'POST /account/billing\ncard=**** **** **** 4242\naddress=12 Elm Street\n(saved to the attacker account)',
          note: 'The victim believes this is their own account and saves payment details to order prints.',
          outcome: 'warning',
        },
        {
          from: 'attacker',
          to: 'app',
          title: 'Attacker opens own account',
          wire: 'GET /account/billing\n(the attacker signs in to that account the normal way)',
          note: 'No stolen credential is needed: this is the account of the attacker. The attacker never got a token or the password of the victim.',
          outcome: 'warning',
        },
        {
          from: 'app',
          to: 'attacker',
          title: 'Victim card and address shown',
          wire: '200 OK\ncard **** 4242 (saved by the victim)\naddress 12 Elm Street',
          note: 'This is the harm of login CSRF (RFC 6749, section 10.12): the victim acted inside the account of the attacker, and the attacker reads - and can order prints with - what the victim left there.',
          outcome: 'warning',
        },
      ],
      verdict: 'breached',
      headline: 'The forged callback worked',
      summary:
        'With neither state nor PKCE, the app redeemed a code it never asked for and signed the victim in to the attacker account. The attacker got no victim tokens and no password - the harm is what the victim does next, inside an account the attacker can open. Turn state or PKCE on and replay.',
    };
  }

  // The honest flow.
  const needs = call === 'read' ? 'photos.read' : 'photos.write';
  const allowed = scope.split(' ').includes(needs);
  const steps: Step[] = [
    signIn,
    toAuthorize,
    openAuthorize,
    login,
    codeBack,
    {
      from: 'user',
      to: 'app',
      title: 'Browser hands the code over',
      wire: `GET /cb?code=${CODE}${state ? `&state=${state}` : ''}`,
      note: stateCheck
        ? 'The app compares state with the value it stored for this browser. It matches, so this callback answers a flow this browser started.'
        : 'The state check is off: the app accepts any code that arrives at its callback.',
      outcome: 'success',
    },
    {
      from: 'app',
      to: 'auth',
      title: 'Code plus verifier to /token',
      wire: tokenRequest(CODE, REDIRECT, pkce ? VERIFIER : null),
      note: pkce
        ? 'This call goes server to server (or app to server), not through the browser. The code_verifier travels for the first time.'
        : 'Without PKCE, the code and the public client_id are all the server gets.',
      outcome: 'success',
    },
    {
      from: 'auth',
      to: 'app',
      title: 'Access and refresh token issued',
      wire: tokenResponse(scope),
      note: pkce
        ? 'SHA-256 of the code_verifier equals the stored code_challenge, the code is unused and in time - so tokens are issued.'
        : 'The code is unused and in time - so tokens are issued.',
      outcome: 'success',
    },
    {
      from: 'app',
      to: 'res',
      title: 'API call with the access token',
      wire: `${call === 'read' ? 'GET /photos' : 'DELETE /photos/7'}\nAuthorization: Bearer ${ACCESS_TOKEN}`,
      note: `The resource server checks the token, then whether its scope includes ${needs}.`,
      outcome: 'success',
    },
    allowed
      ? {
          from: 'res',
          to: 'app',
          title: 'Scope checked, data returned',
          wire: call === 'read' ? '200 OK\n[ 42 photos ]' : '204 No Content',
          note: `The token carries ${needs}, so the call is allowed.`,
          outcome: 'success',
        }
      : {
          from: 'res',
          to: 'app',
          title: 'Refused: scope too narrow',
          wire: `403 Forbidden\nWWW-Authenticate: Bearer error="insufficient_scope",\n  scope="${needs}"`,
          note: `The token is valid but carries only ${scope}. The user never granted ${needs}.`,
          outcome: 'failure',
        },
  ];
  return allowed
    ? {
        steps,
        verdict: 'ok',
        headline: 'Signed in without sharing the password',
        summary: `The app got a ${scope} token and called the API. The password went only to the authorization server, and the user can revoke this token without changing it.`,
      }
    : {
        steps,
        verdict: 'denied',
        stoppedBy: 'scope check',
        rejectedBy: 'res',
        headline: 'The resource server enforced the scope',
        summary: `The token is genuine, but it was granted for ${scope} only, so the DELETE was refused with 403. Scopes limit what a token can do even when everything else is valid.`,
      };
}

// Design space 960 x 470. Every wire runs through a gap between cards. Each card is as tall as
// its two stat rows make it, so the wires meet its real edge.
const LAYOUT: Layout = {
  user: { x: 30, y: 164, w: 190, h: 130 },
  auth: { x: 370, y: 16, w: 230, h: 130 },
  app: { x: 720, y: 164, w: 210, h: 130 },
  attacker: { x: 370, y: 328, w: 210, h: 130 },
  res: { x: 720, y: 328, w: 210, h: 130 },
};

const pairKey = (a: Party, b: Party) => [a, b].sort().join('|');

/** The wires the attacker needs for each attack - only those are drawn. */
const ATTACK_WIRES: Record<Attack, [Party, Party][]> = {
  none: [],
  'stolen-code': [
    ['user', 'attacker'],
    ['attacker', 'auth'],
    ['attacker', 'res'],
  ],
  redirect: [
    ['attacker', 'user'],
    ['attacker', 'auth'],
    ['attacker', 'res'],
  ],
  csrf: [
    ['attacker', 'user'],
    ['attacker', 'app'],
  ],
};

const BASE_WIRES: [Party, Party][] = [
  ['user', 'app'],
  ['user', 'auth'],
  ['app', 'auth'],
  ['app', 'res'],
];

const OUTCOME_TONE: Record<RequestOutcome, EdgeTone> = {
  success: 'brand',
  'cache-hit': 'ok',
  warning: 'warn',
  failure: 'danger',
};

const LOG_TONE: Record<RequestOutcome, EventTone> = {
  success: 'info',
  'cache-hit': 'ok',
  warning: 'warn',
  failure: 'danger',
};

const VERDICT_LABEL: Record<Verdict, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  ok: { label: 'Signed in', tone: 'ok' },
  denied: { label: 'Call refused', tone: 'warn' },
  blocked: { label: 'Attack blocked', tone: 'ok' },
  breached: { label: 'Attack worked', tone: 'danger' },
};

/** Seconds a message takes to cross its wire, and the pause after it lands. */
const TRAVEL_S = 1.1;
const HOLD_S = 0.6;

interface Sim {
  index: number;
  /** Progress of the current message along its wire, 0..1. */
  t: number;
  hold: number;
  done: boolean;
  blocked: number;
  breached: number;
}

export function OAuthLab() {
  const [setup, setSetup] = useState<Setup>(DEFAULT_SETUP);
  const { attack, pkce, stateCheck, exactRedirect, scope, call } = setup;
  const run = useMemo(() => buildRun(setup), [setup]);
  const { steps } = run;

  const [running, setRunning] = useLabRunning();
  const sim = useRef<Sim>({ index: 0, t: 0, hold: 0, done: false, blocked: 0, breached: 0 });
  const rerender = useRerender(30);
  const { events, log, clear } = useEventLog(40);

  const restart = () => {
    sim.current = { ...sim.current, index: 0, t: 0, hold: 0, done: false };
  };

  const change =
    <K extends keyof Setup>(key: K) =>
    (value: Setup[K]) => {
      setSetup((current) => ({ ...current, [key]: value }));
      // A new setup is a new run: replay it from the first message.
      restart();
      setRunning(true);
    };

  /** The current message has landed: log it, then move on or finish. */
  const land = (current: Run) => {
    const s = sim.current;
    const step = current.steps[s.index];
    log(`${s.index + 1}. ${step.title}`, LOG_TONE[step.outcome]);
    if (s.index + 1 < current.steps.length) {
      s.index += 1;
      s.t = 0;
      s.hold = 0;
      return;
    }
    s.done = true;
    s.t = 1;
    if (current.verdict === 'blocked') s.blocked += 1;
    if (current.verdict === 'breached') s.breached += 1;
    log(current.headline, current.verdict === 'breached' ? 'danger' : current.verdict === 'denied' ? 'warn' : 'ok');
    setRunning(false);
  };

  useTicker(running, (dt) => {
    const s = sim.current;
    if (s.done) return;
    if (s.t < 1) {
      s.t = Math.min(1, s.t + dt / TRAVEL_S);
    } else {
      s.hold += dt;
      if (s.hold >= HOLD_S) land(run);
    }
    rerender();
  });

  const nextStep = () => {
    const s = sim.current;
    if (s.done) {
      restart();
    } else {
      land(run);
    }
    setRunning(false);
    rerender();
  };

  const changeRunning = (next: boolean) => {
    if (next && sim.current.done) restart();
    setRunning(next);
  };

  const s = sim.current;
  const step = steps[Math.min(s.index, steps.length - 1)];
  const finished = s.done;
  const activeKey = finished ? null : pairKey(step.from, step.to);

  const edges: DiagramEdge[] = [...BASE_WIRES, ...ATTACK_WIRES[attack]].map(([from, to]) => {
    const key = pairKey(from, to);
    const isAttacker = from === 'attacker' || to === 'attacker';
    const active = key === activeKey;
    return {
      from,
      to,
      tone: active ? OUTCOME_TONE[step.outcome] : isAttacker ? 'danger' : 'default',
      dashed: isAttacker && !active,
      animated: active,
      width: active ? 2.25 : 1.75,
    };
  });

  const particles: ParticleView[] = finished
    ? []
    : [{ id: s.index, from: step.from, to: step.to, t: s.t, outcome: step.outcome }];

  /** Status line of one card: who is talking now, and who said no. */
  const statusOf = (party: Party): { status: NodeStatus; label: string } => {
    if (finished && run.rejectedBy === party) return { status: 'healthy', label: 'Refused the request' };
    if (party === 'attacker') {
      if (finished) {
        if (run.verdict !== 'breached') return { status: 'down', label: 'Got nothing usable' };
        // Login CSRF gives the attacker no victim tokens: the victim works inside the attacker account.
        return attack === 'csrf'
          ? { status: 'degraded', label: 'Reads what victim saved' }
          : { status: 'degraded', label: 'Holds victim tokens' };
      }
      return { status: 'degraded', label: 'Attacker' };
    }
    if (!finished && step.from === party) return { status: 'starting', label: 'Sending' };
    if (!finished && step.to === party) return { status: 'starting', label: 'Receiving' };
    return { status: 'healthy', label: 'Idle' };
  };

  const node = (party: Party, kind: 'client' | 'server' | 'api-gateway' | 'service', title: string, subtitle: string, rows: [string, string, string?][]) => {
    const { status, label } = statusOf(party);
    return (
      <ArchNode
        kind={kind}
        title={title}
        subtitle={subtitle}
        placed={LAYOUT[party]}
        status={status}
        statusLabel={label}
        selected={!finished && (step.from === party || step.to === party)}
        alert={party === 'attacker'}
      >
        {rows.map(([rowLabel, value, tone]) => (
          <NodeStatRow key={rowLabel} label={rowLabel} value={value} tone={tone} />
        ))}
      </ArchNode>
    );
  };

  /** What the attacker holds and gets - login CSRF never yields the tokens of the victim. */
  const breached = finished && run.verdict === 'breached';
  const attackerRows: [string, string, string?][] = [
    [
      'holds',
      breached ? (attack === 'csrf' ? 'own account only' : 'victim tokens') : attack === 'csrf' ? 'own account code' : 'no victim tokens',
      breached && attack !== 'csrf' ? 'text-danger' : 'text-faint',
    ],
    [
      'gets',
      !finished ? '-' : breached ? (attack === 'csrf' ? 'victim card, address' : 'victim photos') : 'nothing',
      breached ? 'text-danger' : 'text-faint',
    ],
  ];

  const defences: { attack: Attack; label: string; defence: string; holds: boolean }[] = [
    { attack: 'stolen-code', label: 'Stolen code', defence: 'PKCE', holds: pkce },
    { attack: 'redirect', label: 'Tampered redirect_uri', defence: 'Exact redirect URI match', holds: exactRedirect },
    { attack: 'csrf', label: 'Forged callback', defence: 'state, or PKCE', holds: stateCheck || pkce },
  ];

  return (
    <LabShell
      title="OAuth Lab"
      description="The authorization code flow with PKCE, one message at a time, between the user, the client app, the authorization server and the resource server. Then attack it and see which defence stops which attack."
      running={running}
      onRunningChange={changeRunning}
      onReset={() => {
        setSetup(DEFAULT_SETUP);
        sim.current = { index: 0, t: 0, hold: 0, done: false, blocked: 0, breached: 0 };
        clear();
      }}
      actions={
        <Button onClick={nextStep}>
          <StepForward className="h-4 w-4" />
          {finished ? 'Start over' : 'Next message'}
        </Button>
      }
      events={events}
      legend={
        <div className="space-y-1">
          <ParticleLegend
            outcomes={[
              { outcome: 'success', label: 'Message of the flow' },
              { outcome: 'warning', label: 'Message the attack causes' },
              { outcome: 'failure', label: 'Refusal' },
            ]}
          />
          <p className="text-[11px] text-faint">
            Here a triangle is a message the attack sends or causes, and a cross is a message that refuses the request.
            Dashed red wires are the ones the attacker uses.
          </p>
        </div>
      }
      insight={
        <Insight title={finished ? run.headline : `Message ${s.index + 1} of ${steps.length}: ${step.title}`}>
          {finished ? run.summary : step.note}
        </Insight>
      }
      metrics={
        <>
          <MetricsPanel
            items={[
              {
                key: 'message',
                label: 'Message',
                value: `${finished ? steps.length : s.index + 1}/${steps.length}`,
                hint: 'Which HTTP message of this run is on the wire.',
              },
              {
                key: 'outcome',
                label: 'Outcome',
                value: finished ? VERDICT_LABEL[run.verdict].label : 'In flight',
                tone: finished ? VERDICT_LABEL[run.verdict].tone : 'neutral',
                hint: 'How this run ended, once the last message lands.',
              },
              {
                key: 'stoppedBy',
                label: 'Stopped by',
                value: finished && run.stoppedBy ? run.stoppedBy : '-',
                tone: run.verdict === 'blocked' && finished ? 'ok' : 'neutral',
                hint: 'The defence or check that said no.',
              },
              {
                key: 'password',
                label: 'Password seen by',
                value: 'Auth server',
                tone: 'ok',
                hint: 'In every run the password is typed at the authorization server. The client app never receives it.',
              },
              { key: 'blocked', label: 'Attacks blocked', value: s.blocked, tone: s.blocked > 0 ? 'ok' : 'neutral' },
              { key: 'breached', label: 'Attacks that worked', value: s.breached, tone: s.breached > 0 ? 'danger' : 'neutral' },
              {
                key: 'lifetime',
                label: 'Access token life',
                value: `${TOKEN_LIFETIME_S / 60} min`,
                hint: 'The expires_in this Lab uses - an example value; each authorization server picks its own. Short lifetimes bound the damage of a leaked token.',
                simulated: true,
              },
            ]}
          />

          <div className="card p-4">
            <p className="label mb-3">On the wire</p>
            <p className="mb-2 text-xs text-muted">
              {finished ? (
                <>Run finished. The last message is shown.</>
              ) : (
                <>
                  <span className="font-medium text-ink">{step.title}</span> - {PARTY_NAME[step.from]} to {PARTY_NAME[step.to]}
                </>
              )}
            </p>
            <pre className="ascii overflow-x-auto">{step.wire}</pre>
            <p className="mt-2 text-[11px] text-faint">
              Example values from RFC 6749 and RFC 7636. Real codes, verifiers and tokens are random strings.
            </p>
          </div>

          <div className="card p-4">
            <p className="label mb-3">Messages in this run</p>
            <ol className="space-y-1.5">
              {steps.map((item, index) => {
                const done = finished || index < s.index;
                const active = !finished && index === s.index;
                return (
                  <li
                    key={`${index}-${item.title}`}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                      active ? 'bg-brand/10' : done ? undefined : 'opacity-50',
                    )}
                  >
                    <span className="w-5 shrink-0 font-mono text-[11px] text-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">{item.title}</span>
                      <span className="block text-[11px] text-faint">
                        {PARTY_NAME[item.from]} to {PARTY_NAME[item.to]}
                      </span>
                    </span>
                    <Badge tone={item.outcome === 'failure' ? 'danger' : item.outcome === 'warning' ? 'warn' : 'brand'}>
                      {item.outcome === 'failure' ? 'refused' : item.outcome === 'warning' ? 'attack' : 'flow'}
                    </Badge>
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      }
      controls={
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Attack</p>
            <div className="space-y-1.5">
              {ATTACKS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={attack === item.value}
                  onClick={() => change('attack')(item.value)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    attack === item.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/50 hover:text-ink',
                  )}
                >
                  <span className="block text-xs font-medium">{item.label}</span>
                  <span className="block text-[11px] text-faint">{item.blurb}</span>
                </button>
              ))}
            </div>
          </div>
          <Toggle
            label="PKCE"
            checked={pkce}
            onChange={change('pkce')}
            description="The app sends a code_challenge, then proves it with the code_verifier"
          />
          <Toggle
            label="state check"
            checked={stateCheck}
            onChange={change('stateCheck')}
            description="The app only accepts a callback carrying the state it stored"
          />
          <Toggle
            label="Exact redirect URI match"
            checked={exactRedirect}
            onChange={change('exactRedirect')}
            description="Off: the server accepts any redirect_uri that starts with the registered origin"
          />
          <Select
            label="Scope the user grants"
            value={scope}
            options={SCOPES}
            onChange={change('scope')}
            hint="What the access token is allowed to do."
          />
          <Select
            label="API call the app makes"
            value={call}
            options={CALLS}
            onChange={change('call')}
            hint="Used in the honest flow. The resource server checks it against the token scope."
          />
          <div className="border-t border-line pt-4 text-[11px] text-muted">
            <p className="label mb-2">Which defence stops which attack</p>
            <ul className="space-y-1.5">
              {defences.map((row) => (
                <li
                  key={row.attack}
                  className={cn('flex items-center justify-between gap-2', attack === row.attack && 'font-medium text-ink')}
                >
                  <span className="min-w-0">
                    {row.label}
                    <span className="block text-faint">{row.defence}</span>
                  </span>
                  <Badge tone={row.holds ? 'ok' : 'danger'}>{row.holds ? 'blocked' : 'gets through'}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-faint">The app here is a public client (a phone or browser app), so it has no client secret.</p>
          </div>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs">
        <Badge tone={finished ? VERDICT_LABEL[run.verdict].tone : 'brand'}>
          {finished ? VERDICT_LABEL[run.verdict].label : `${s.index + 1}/${steps.length}`}
        </Badge>
        <span className="font-medium text-ink">{finished ? run.headline : step.title}</span>
      </div>
      <DiagramCanvas layout={LAYOUT} edges={edges} particles={particles} height={470} className="bg-canvas">
        {node('user', 'client', 'User browser', 'resource owner', [
          ['password goes to', 'auth only'],
          ['scope granted', scope === 'photos.read' ? 'read' : 'read + write'],
        ])}
        {node('app', 'server', 'Client app', 'printapp, public client', [
          ['code_verifier', pkce ? 'kept secret' : 'none', pkce ? 'text-ok' : 'text-danger'],
          ['state', stateCheck ? 'stored, checked' : 'not checked', stateCheck ? 'text-ok' : 'text-danger'],
        ])}
        {node('auth', 'api-gateway', 'Authorization server', 'login, consent, tokens', [
          ['redirect_uri check', exactRedirect ? 'exact' : 'prefix only', exactRedirect ? 'text-ok' : 'text-danger'],
          ['code_challenge', pkce ? 'required' : 'not used', pkce ? 'text-ok' : 'text-danger'],
        ])}
        {node('res', 'service', 'Resource server', 'photos API', [
          ['token scope', scope === 'photos.read' ? 'read' : 'read + write'],
          ['call needs', call === 'read' ? 'photos.read' : 'photos.write'],
        ])}
        {attack !== 'none'
          ? node('attacker', 'client', 'Attacker', ATTACKS.find((item) => item.value === attack)?.label ?? '', attackerRows)
          : null}
      </DiagramCanvas>
    </LabShell>
  );
}

const PARTY_NAME: Record<Party, string> = {
  user: 'User browser',
  app: 'Client app',
  auth: 'Authorization server',
  res: 'Resource server',
  attacker: 'Attacker',
};

export default OAuthLab;
