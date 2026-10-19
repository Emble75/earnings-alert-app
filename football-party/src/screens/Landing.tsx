import { Link } from 'react-router-dom';
import { ArrowRight, Link2, Smartphone, UserRoundX } from 'lucide-react';
import { gameMetaList } from '@/games/meta';
import { LinkButton, PitchLines } from '@/ui/kit';
import { Page } from './Shell';

export function Landing() {
  return (
    <Page>
      <section className="hero">
        <PitchLines variant="half" />
        <div className="hero-inner">
          <div className="eyebrow lime">Football party games · No accounts · Play from a link</div>
          <h1 className="hero-title">
            <span>Find the</span>
            <span className="hl">faker.</span>
            <span className="outline">Name the</span>
            <span>player.</span>
          </h1>
          <p className="hero-sub">
            Make a room, share the code, and settle the group-chat arguments properly. Two football
            games built for phones, with every answer checked against real records — not vibes.
          </p>
          <div className="row wrap hero-cta">
            <LinkButton to="/play" size="lg">
              Start a room <ArrowRight aria-hidden />
            </LinkButton>
            <LinkButton to="/play#join" size="lg" variant="secondary">
              I have a code
            </LinkButton>
          </div>
        </div>
        <HeroCards />
      </section>

      <section className="fixtures" aria-labelledby="fixtures-h">
        <div className="section-head">
          <div className="eyebrow">Today’s fixtures</div>
          <h2 id="fixtures-h">Two games. One group chat.</h2>
        </div>
        {gameMetaList.map((g, i) => (
          <article key={g.id} className={`fixture ${i % 2 ? 'flip' : ''}`}>
            <div className="fixture-num mono" aria-hidden>
              0{i + 1}
            </div>
            <div className="fixture-copy">
              <div className="eyebrow lime">{g.kicker}</div>
              <h3>{g.title}</h3>
              <p>{g.blurb}</p>
              <div className="row wrap" style={{ marginTop: 'var(--s-4)' }}>
                <span className="chip">{g.players}</span>
                <span className="chip">{g.length}</span>
              </div>
              <div className="row wrap" style={{ marginTop: 'var(--s-5)' }}>
                <LinkButton to="/play" size="sm">
                  Play with friends
                </LinkButton>
                <LinkButton to={`/practice/${g.id}`} size="sm" variant="secondary">
                  Try it offline
                </LinkButton>
              </div>
            </div>
            <div className="fixture-art" aria-hidden>
              {g.id === 'impostor' ? <ImpostorArt /> : <GridArt />}
            </div>
          </article>
        ))}
      </section>

      <section className="steps" aria-labelledby="steps-h">
        <div className="section-head">
          <div className="eyebrow">Kick-off in 30 seconds</div>
          <h2 id="steps-h">How it works</h2>
        </div>
        <ol className="step-list">
          <li>
            <Smartphone aria-hidden size={28} />
            <h3>Make a room</h3>
            <p>Pick a nickname. You get a five-letter code and a link.</p>
          </li>
          <li>
            <Link2 aria-hidden size={28} />
            <h3>Share the link</h3>
            <p>Friends join from any phone or laptop. No download, no sign-up.</p>
          </li>
          <li>
            <UserRoundX aria-hidden size={28} />
            <h3>Play &amp; rematch</h3>
            <p>Server-timed rounds, live scores, and one tap to run it back.</p>
          </li>
        </ol>
      </section>

      <section className="honesty card paper" aria-labelledby="honest-h">
        <div className="eyebrow">Straight talk about the data</div>
        <h2 id="honest-h">Every answer is checked. Some answers aren’t knowable yet.</h2>
        <p>
          Tic-Tac-Toe validates players against dated club, national-team and league records. If our
          data can’t prove a fact, the game treats it as unknown and never uses it. The built-in set
          is a small hand-curated <strong>sample</strong>, clearly labelled — not a live or complete
          database.
        </p>
        <Link
          to="/data"
          className="btn paper sm"
          style={{ marginTop: 'var(--s-4)', width: 'fit-content' }}
        >
          How data works <ArrowRight aria-hidden size={18} />
        </Link>
      </section>
    </Page>
  );
}

function HeroCards() {
  return (
    <div className="hero-cards" aria-hidden>
      <div className="hc hc-a">
        <div className="eyebrow">Your secret</div>
        <div className="hc-big">Impostor</div>
        <div className="hc-line">“Plays as a forward.”</div>
      </div>
      <div className="hc hc-b">
        <div className="mini-board">
          {['ARS', 'BRA', 'PL', 'MUN', '', '', '', 'X', ''].map((t, i) => (
            <span key={i} className={t === 'X' ? 'x' : ''}>
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="hc hc-c mono">02:14</div>
    </div>
  );
}

function ImpostorArt() {
  return (
    <div className="art-impostor">
      <div className="art-card a1">
        <span className="eyebrow">Crew</span>
        <b>???</b>
      </div>
      <div className="art-card a2">
        <span className="eyebrow">Crew</span>
        <b>???</b>
      </div>
      <div className="art-card a3">
        <span className="eyebrow" style={{ color: 'var(--card-red)' }}>
          Impostor
        </span>
        <b>—</b>
      </div>
    </div>
  );
}
function GridArt() {
  return (
    <div className="art-grid">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={[0, 4, 8].includes(i) ? 'on' : ''}>
          {[0, 8].includes(i) ? 'X' : i === 4 ? 'X' : i === 2 ? 'O' : i === 6 ? 'O' : ''}
        </span>
      ))}
    </div>
  );
}
