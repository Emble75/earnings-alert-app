import { Link } from 'react-router-dom';
import { ArrowRight, Hand, Wifi } from 'lucide-react';
import { gameMetaList } from '@/games/meta';
import { LinkButton, PitchLines } from '@/ui/kit';
import { Page } from './Shell';

export function Landing() {
  return (
    <Page>
      <section className="home-hero">
        <PitchLines variant="half" />
        <div className="eyebrow lime">Football party games · No accounts</div>
        <h1 className="home-title">
          Pick a game.
          <br />
          <span className="hl">Beat your friends.</span>
        </h1>
        <p className="hero-sub">
          Quick football games for one phone or the whole group chat. Every answer is checked
          against real records.
        </p>
      </section>

      <section className="home-section" aria-labelledby="games-h">
        <h2 id="games-h" className="home-h">
          1 · The games
        </h2>
        <div className="games-grid">
          {gameMetaList.map((g) => (
            <article key={g.id} className="card game-card">
              <g.icon size={32} aria-hidden />
              <div className="eyebrow">{g.kicker}</div>
              <h3>{g.title}</h3>
              <p>{g.tagline}</p>
              <div className="row wrap">
                <span className="chip">{g.players}</span>
                <span className="chip">{g.length}</span>
              </div>
              <div className="row wrap game-card-cta">
                <LinkButton to={`/party/${g.id}`} size="sm">
                  One phone
                </LinkButton>
                <LinkButton to="/play" size="sm" variant="secondary">
                  Online
                </LinkButton>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section" aria-labelledby="modes-h">
        <h2 id="modes-h" className="home-h">
          2 · How you play
        </h2>
        <div className="modes-grid">
          <Link to="/party" className="card mode-card">
            <Hand size={36} aria-hidden />
            <h3>One phone</h3>
            <p>Everyone around one phone. Nothing to set up, no hand-overs.</p>
            <span className="mode-go">
              Start <ArrowRight size={18} aria-hidden />
            </span>
          </Link>
          <Link to="/play" className="card mode-card">
            <Wifi size={36} aria-hidden />
            <h3>Online</h3>
            <p>Everyone on their own phone. Share a 5-letter room code.</p>
            <span className="mode-go">
              Create or join <ArrowRight size={18} aria-hidden />
            </span>
          </Link>
        </div>
      </section>

      <p className="home-note">
        Only confirmed records count — if the data can’t prove it, the game never guesses. The
        built-in set is a small <strong>sample</strong>. <Link to="/data">How the data works</Link>
      </p>
    </Page>
  );
}
