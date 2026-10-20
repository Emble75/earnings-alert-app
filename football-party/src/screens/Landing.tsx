import { Link } from 'react-router-dom';
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
        <p className="home-join">
          Got a room code? <Link to="/play#join">Join a room</Link>
        </p>
      </section>

      <section className="home-section" aria-labelledby="games-h">
        <h2 id="games-h" className="home-h">
          Choose a game
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
                <LinkButton to={`/play?game=${g.id}`} size="sm" variant="secondary">
                  Online
                </LinkButton>
              </div>
            </article>
          ))}
        </div>
      </section>

      <p className="home-note">
        Only confirmed records count — if the data can’t prove it, the game never guesses.{' '}
        <Link to="/data">How the data works</Link>
      </p>
    </Page>
  );
}
