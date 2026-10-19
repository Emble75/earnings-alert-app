import {
  DatasetSchema,
  type Dataset,
  type Affiliation,
  type Team,
} from '../../shared/football/types';

/**
 * SAMPLE DATA — hand-curated for local development, tests and the offline practice mode.
 *
 *  - It is NOT live, NOT complete and NOT provider-verified. Careers list only the clubs in this
 *    file's club table, at season granularity ("2003-2008" = seasons 2003-04 … 2008-09), and
 *    follow senior-squad registration (loan spells count for the club that registered the player).
 *  - Open-ended entries ("2024-") are ongoing as of the snapshot season below, nothing later.
 *  - Anything uncertain was left out rather than guessed. Report errors via a data issue.
 */
const SOURCE = 'sample';
export const SAMPLE_CURRENT_SEASON = 2024;

type ClubRow = [
  id: string,
  name: string,
  short: string,
  country: string,
  color: string,
  aliases?: string,
];
const CLUBS: ClubRow[] = [
  ['man-utd', 'Manchester United', 'MUN', 'England', '#DA291C', 'Man United,Man Utd,Man U'],
  ['chelsea', 'Chelsea', 'CHE', 'England', '#034694'],
  ['arsenal', 'Arsenal', 'ARS', 'England', '#EF0107', 'The Gunners'],
  ['liverpool', 'Liverpool', 'LIV', 'England', '#C8102E'],
  ['man-city', 'Manchester City', 'MCI', 'England', '#6CABDD', 'Man City'],
  ['tottenham', 'Tottenham Hotspur', 'TOT', 'England', '#132257', 'Spurs,Tottenham'],
  ['real-madrid', 'Real Madrid', 'RMA', 'Spain', '#F2F2F2', 'Los Blancos'],
  ['barcelona', 'FC Barcelona', 'BAR', 'Spain', '#A50044', 'Barca,Barcelona'],
  ['atletico', 'Atlético Madrid', 'ATM', 'Spain', '#CB3524', 'Atletico Madrid,Atleti'],
  ['juventus', 'Juventus', 'JUV', 'Italy', '#1C1C1C', 'Juve'],
  ['inter', 'Inter Milan', 'INT', 'Italy', '#0068A8', 'Internazionale,Inter'],
  ['milan', 'AC Milan', 'MIL', 'Italy', '#FB090B', 'Milan'],
  ['roma', 'AS Roma', 'ROM', 'Italy', '#8E1F2F', 'Roma'],
  [
    'bayern',
    'Bayern Munich',
    'FCB',
    'Germany',
    '#DC052D',
    'FC Bayern,Bayern München,Bayern Munchen',
  ],
  ['dortmund', 'Borussia Dortmund', 'BVB', 'Germany', '#FDE100', 'BVB,Dortmund'],
  ['psg', 'Paris Saint-Germain', 'PSG', 'France', '#004170', 'PSG,Paris SG'],
  ['monaco', 'AS Monaco', 'MON', 'France', '#E51B24', 'Monaco'],
  ['ajax', 'Ajax', 'AJA', 'Netherlands', '#D2122E', 'AFC Ajax'],
  ['porto', 'FC Porto', 'FCP', 'Portugal', '#003A8F', 'Porto'],
  ['sporting', 'Sporting CP', 'SCP', 'Portugal', '#00805A', 'Sporting Lisbon'],
];

type NationRow = [code: string, name: string, short: string, color: string];
const NATIONS: NationRow[] = [
  ['eng', 'England', 'ENG', '#CF081F'],
  ['esp', 'Spain', 'ESP', '#AA151B'],
  ['fra', 'France', 'FRA', '#0055A4'],
  ['bra', 'Brazil', 'BRA', '#009C3B'],
  ['arg', 'Argentina', 'ARG', '#75AADB'],
  ['por', 'Portugal', 'POR', '#006600'],
  ['ger', 'Germany', 'GER', '#2B2B2B'],
  ['ned', 'Netherlands', 'NED', '#F36C21'],
  ['ita', 'Italy', 'ITA', '#0066B2'],
  ['bel', 'Belgium', 'BEL', '#ED2939'],
  ['cro', 'Croatia', 'CRO', '#C8102E'],
  ['pol', 'Poland', 'POL', '#DC143C'],
  ['uru', 'Uruguay', 'URU', '#5CBFEB'],
  ['swe', 'Sweden', 'SWE', '#006AA7'],
  ['nor', 'Norway', 'NOR', '#BA0C2F'],
  ['civ', 'Ivory Coast', 'CIV', '#F77F00'],
  ['cmr', 'Cameroon', 'CMR', '#007A5E'],
  ['egy', 'Egypt', 'EGY', '#CE1126'],
  ['sen', 'Senegal', 'SEN', '#00853F'],
  ['kor', 'South Korea', 'KOR', '#CD2E3A'],
  ['wal', 'Wales', 'WAL', '#C8102E'],
  ['chi', 'Chile', 'CHI', '#D52B1E'],
  ['gab', 'Gabon', 'GAB', '#009E60'],
];

const LEAGUES: [id: string, name: string, short: string, country: string, aliases?: string][] = [
  ['premier-league', 'Premier League', 'PL', 'England', 'EPL,English Premier League'],
  ['la-liga', 'La Liga', 'LaLiga', 'Spain', 'LaLiga,Primera Division'],
  ['serie-a', 'Serie A', 'Serie A', 'Italy'],
  ['serie-b', 'Serie B', 'Serie B', 'Italy'],
  ['bundesliga', 'Bundesliga', 'BuLi', 'Germany'],
  ['ligue-1', 'Ligue 1', 'L1', 'France'],
  ['eredivisie', 'Eredivisie', 'Ere', 'Netherlands'],
  ['primeira-liga', 'Primeira Liga', 'PrL', 'Portugal', 'Liga Portugal'],
];

/** team, league, fromSeason, toSeason (null = ongoing). Spells away from a league are modelled. */
const MEMBERSHIPS: [string, string, number, number | null][] = [
  ...['man-utd', 'chelsea', 'arsenal', 'liverpool', 'tottenham'].map(
    (t) => [t, 'premier-league', 1992, null] as [string, string, number, null],
  ),
  ['man-city', 'premier-league', 1992, 2000], // relegated after 2000-01
  ['man-city', 'premier-league', 2002, null], // back up for 2002-03
  ['real-madrid', 'la-liga', 1990, null],
  ['barcelona', 'la-liga', 1990, null],
  ['atletico', 'la-liga', 1990, 1999], // relegated after 1999-00
  ['atletico', 'la-liga', 2002, null], // back up for 2002-03
  ['inter', 'serie-a', 1990, null],
  ['milan', 'serie-a', 1990, null],
  ['roma', 'serie-a', 1990, null],
  ['juventus', 'serie-a', 1990, 2005],
  ['juventus', 'serie-b', 2006, 2006], // 2006-07 in Serie B
  ['juventus', 'serie-a', 2007, null],
  ['bayern', 'bundesliga', 1990, null],
  ['dortmund', 'bundesliga', 1990, null],
  ['psg', 'ligue-1', 1990, null],
  ['monaco', 'ligue-1', 1990, 2010],
  ['monaco', 'ligue-1', 2013, null], // Ligue 2 in 2011-12 and 2012-13
  ['ajax', 'eredivisie', 1990, null],
  ['porto', 'primeira-liga', 1990, null],
  ['sporting', 'primeira-liga', 1990, null],
];

/**
 * id | name | born | position | tier | nations | aliases | careers
 * careers: "club:from-to" (season start years, inclusive; blank `to` = ongoing)
 */
const PLAYERS = `
cristiano-ronaldo|Cristiano Ronaldo|1985|FWD|1|por|CR7,Ronaldo|sporting:2002-2002,man-utd:2003-2008,real-madrid:2009-2017,juventus:2018-2020,man-utd:2021-2022
lionel-messi|Lionel Messi|1987|FWD|1|arg|Leo Messi|barcelona:2004-2020,psg:2021-2022
neymar|Neymar|1992|FWD|1|bra|Neymar Jr|barcelona:2013-2016,psg:2017-2022
kylian-mbappe|Kylian Mbappé|1998|FWD|1|fra||monaco:2015-2016,psg:2017-2023,real-madrid:2024-
zinedine-zidane|Zinedine Zidane|1972|MID|1|fra|Zizou|juventus:1996-2000,real-madrid:2001-2005
thierry-henry|Thierry Henry|1977|FWD|1|fra||monaco:1994-1998,juventus:1998-1998,arsenal:1999-2006,barcelona:2007-2009
david-beckham|David Beckham|1975|MID|1|eng|Becks|man-utd:1992-2002,real-madrid:2003-2006,milan:2008-2009,psg:2012-2012
wayne-rooney|Wayne Rooney|1985|FWD|1|eng||man-utd:2004-2016
steven-gerrard|Steven Gerrard|1980|MID|1|eng||liverpool:1998-2014
frank-lampard|Frank Lampard|1978|MID|1|eng||chelsea:2001-2013,man-city:2014-2014
john-terry|John Terry|1980|DEF|2|eng||chelsea:1998-2016
harry-kane|Harry Kane|1993|FWD|1|eng||tottenham:2011-2022,bayern:2023-
raheem-sterling|Raheem Sterling|1994|FWD|2|eng||liverpool:2012-2014,man-city:2015-2021,chelsea:2022-2023
jude-bellingham|Jude Bellingham|2003|MID|1|eng||dortmund:2020-2022,real-madrid:2023-
sergio-aguero|Sergio Agüero|1988|FWD|1|arg|Kun Aguero|atletico:2006-2010,man-city:2011-2020,barcelona:2021-2021
ronaldinho|Ronaldinho|1980|MID|1|bra|Ronaldinho Gaucho|psg:2001-2002,barcelona:2003-2007,milan:2008-2010
ronaldo-nazario|Ronaldo Nazário|1976|FWD|1|bra|R9,O Fenomeno|barcelona:1996-1996,inter:1997-2001,real-madrid:2002-2006,milan:2006-2007
kaka|Kaká|1982|MID|1|bra|Kaka|milan:2003-2008,real-madrid:2009-2012,milan:2013-2013
andres-iniesta|Andrés Iniesta|1984|MID|1|esp|Iniesta|barcelona:2002-2017
xavi|Xavi Hernández|1980|MID|1|esp|Xavi|barcelona:1998-2014
sergio-ramos|Sergio Ramos|1986|DEF|1|esp||real-madrid:2005-2020,psg:2021-2022
iker-casillas|Iker Casillas|1981|GK|1|esp||real-madrid:1999-2014,porto:2015-2019
fernando-torres|Fernando Torres|1984|FWD|1|esp|El Nino|atletico:2001-2006,liverpool:2007-2010,chelsea:2010-2013
luis-suarez|Luis Suárez|1987|FWD|1|uru||ajax:2007-2010,liverpool:2010-2013,barcelona:2014-2019,atletico:2020-2021
robert-lewandowski|Robert Lewandowski|1988|FWD|1|pol||dortmund:2010-2013,bayern:2014-2021,barcelona:2022-
manuel-neuer|Manuel Neuer|1986|GK|1|ger||bayern:2011-
thomas-muller|Thomas Müller|1989|FWD|1|ger|Thomas Mueller|bayern:2008-
toni-kroos|Toni Kroos|1990|MID|1|ger||bayern:2007-2013,real-madrid:2014-2023
mesut-ozil|Mesut Özil|1988|MID|1|ger||real-madrid:2010-2012,arsenal:2013-2020
erling-haaland|Erling Haaland|2000|FWD|1|nor||dortmund:2019-2021,man-city:2022-
kevin-de-bruyne|Kevin De Bruyne|1991|MID|1|bel|KDB|man-city:2015-
eden-hazard|Eden Hazard|1991|MID|1|bel||chelsea:2012-2018,real-madrid:2019-2022
romelu-lukaku|Romelu Lukaku|1993|FWD|2|bel||chelsea:2011-2013,man-utd:2017-2018,inter:2019-2020,chelsea:2021-2021,inter:2022-2022,roma:2023-2023
luka-modric|Luka Modrić|1985|MID|1|cro||tottenham:2008-2011,real-madrid:2012-
virgil-van-dijk|Virgil van Dijk|1991|DEF|1|ned|VVD|liverpool:2017-
arjen-robben|Arjen Robben|1984|FWD|1|ned||chelsea:2004-2006,real-madrid:2007-2008,bayern:2009-2018
robin-van-persie|Robin van Persie|1983|FWD|1|ned|RVP|arsenal:2004-2011,man-utd:2012-2014
dennis-bergkamp|Dennis Bergkamp|1969|FWD|1|ned||ajax:1986-1992,inter:1993-1994,arsenal:1995-2005
paolo-maldini|Paolo Maldini|1968|DEF|1|ita||milan:1984-2008
andrea-pirlo|Andrea Pirlo|1979|MID|1|ita||milan:2001-2010,juventus:2011-2014
gianluigi-buffon|Gianluigi Buffon|1978|GK|1|ita|Gigi Buffon|juventus:2001-2017,psg:2018-2018,juventus:2019-2020
alessandro-del-piero|Alessandro Del Piero|1974|FWD|1|ita||juventus:1993-2011
francesco-totti|Francesco Totti|1976|MID|1|ita||roma:1992-2016
zlatan-ibrahimovic|Zlatan Ibrahimović|1981|FWD|1|swe|Zlatan,Ibrahimovic|ajax:2001-2003,juventus:2004-2005,inter:2006-2008,barcelona:2009-2009,milan:2010-2011,psg:2012-2015,man-utd:2016-2017,milan:2019-2022
didier-drogba|Didier Drogba|1978|FWD|1|civ||chelsea:2004-2011,chelsea:2014-2014
samuel-etoo|Samuel Eto'o|1981|FWD|1|cmr|Samuel Etoo|barcelona:2004-2008,inter:2009-2010,chelsea:2013-2013
mohamed-salah|Mohamed Salah|1992|FWD|1|egy|Mo Salah|chelsea:2013-2014,roma:2015-2016,liverpool:2017-
sadio-mane|Sadio Mané|1992|FWD|1|sen|Sadio Mane|liverpool:2016-2021,bayern:2022-2022
son-heung-min|Son Heung-min|1992|FWD|1|kor|Heung-min Son,Sonny|tottenham:2015-
gareth-bale|Gareth Bale|1989|FWD|1|wal||tottenham:2007-2012,real-madrid:2013-2021,tottenham:2020-2020
luis-figo|Luís Figo|1972|MID|1|por|Luis Figo|barcelona:1995-1999,real-madrid:2000-2004,inter:2005-2008
bruno-fernandes|Bruno Fernandes|1994|MID|1|por||sporting:2017-2019,man-utd:2019-
bernardo-silva|Bernardo Silva|1994|MID|1|por||monaco:2014-2016,man-city:2017-
angel-di-maria|Ángel Di María|1988|FWD|1|arg|Angel Di Maria|real-madrid:2010-2013,man-utd:2014-2014,psg:2015-2021,juventus:2022-2022
carlos-tevez|Carlos Tevez|1984|FWD|2|arg||man-utd:2007-2008,man-city:2009-2012,juventus:2013-2014
sergio-busquets|Sergio Busquets|1988|MID|1|esp||barcelona:2008-2022
gerard-pique|Gerard Piqué|1987|DEF|1|esp|Gerard Pique|man-utd:2004-2007,barcelona:2008-2022
karim-benzema|Karim Benzema|1987|FWD|1|fra||real-madrid:2009-2022
antoine-griezmann|Antoine Griezmann|1991|FWD|1|fra||atletico:2014-2018,barcelona:2019-2020,atletico:2021-
paul-pogba|Paul Pogba|1993|MID|1|fra||man-utd:2011-2011,juventus:2012-2015,man-utd:2016-2021,juventus:2022-2023
ngolo-kante|N'Golo Kanté|1991|MID|1|fra|Kante,N'Golo Kante|chelsea:2016-2022
cesc-fabregas|Cesc Fàbregas|1987|MID|1|esp|Cesc Fabregas|arsenal:2003-2010,barcelona:2011-2013,chelsea:2014-2018
david-silva|David Silva|1986|MID|2|esp||man-city:2010-2019
david-villa|David Villa|1981|FWD|2|esp||barcelona:2010-2012,atletico:2013-2013
alexis-sanchez|Alexis Sánchez|1988|FWD|2|chi|Alexis Sanchez|barcelona:2011-2013,arsenal:2014-2017,man-utd:2017-2018,inter:2019-2020
rio-ferdinand|Rio Ferdinand|1978|DEF|2|eng||man-utd:2002-2013
ryan-giggs|Ryan Giggs|1973|MID|1|wal||man-utd:1990-2013
paul-scholes|Paul Scholes|1974|MID|2|eng||man-utd:1994-2012
eric-cantona|Eric Cantona|1966|FWD|1|fra||man-utd:1992-1996
mario-gotze|Mario Götze|1992|MID|2|ger|Mario Gotze|dortmund:2009-2012,bayern:2013-2015,dortmund:2016-2019
marco-reus|Marco Reus|1989|MID|2|ger||dortmund:2012-2023
philipp-lahm|Philipp Lahm|1983|DEF|2|ger||bayern:2002-2016
bastian-schweinsteiger|Bastian Schweinsteiger|1984|MID|2|ger||bayern:2002-2014,man-utd:2015-2016
franck-ribery|Franck Ribéry|1983|FWD|2|fra|Franck Ribery|bayern:2007-2018
edinson-cavani|Edinson Cavani|1987|FWD|2|uru||psg:2013-2019,man-utd:2020-2021
pierre-emerick-aubameyang|Pierre-Emerick Aubameyang|1989|FWD|2|gab|Aubameyang|dortmund:2013-2017,arsenal:2017-2021,barcelona:2021-2021
ilkay-gundogan|İlkay Gündoğan|1990|MID|2|ger|Ilkay Gundogan|dortmund:2011-2015,man-city:2016-2022,barcelona:2023-2023
ousmane-dembele|Ousmane Dembélé|1997|FWD|2|fra|Ousmane Dembele|dortmund:2016-2016,barcelona:2017-2022,psg:2023-
marcelo|Marcelo|1988|DEF|1|bra||real-madrid:2006-2021
dani-alves|Dani Alves|1983|DEF|1|bra||barcelona:2008-2015,juventus:2016-2016,psg:2017-2018
thiago-silva|Thiago Silva|1984|DEF|1|bra||milan:2009-2011,psg:2012-2019,chelsea:2020-2021
david-luiz|David Luiz|1987|DEF|2|bra||chelsea:2010-2013,psg:2014-2015,chelsea:2016-2018,arsenal:2019-2020
gabriel-jesus|Gabriel Jesus|1997|FWD|2|bra||man-city:2016-2021,arsenal:2022-
roberto-firmino|Roberto Firmino|1991|FWD|2|bra||liverpool:2015-2022
alisson|Alisson Becker|1992|GK|1|bra|Alisson|roma:2016-2017,liverpool:2018-
lamine-yamal|Lamine Yamal|2007|FWD|1|esp||barcelona:2023-
pedri|Pedri|2002|MID|1|esp||barcelona:2020-
vinicius-junior|Vinícius Júnior|2000|FWD|1|bra|Vinicius Junior,Vini Jr|real-madrid:2018-
rodri|Rodri|1996|MID|1|esp||atletico:2018-2018,man-city:2019-
phil-foden|Phil Foden|2000|MID|1|eng||man-city:2017-
bukayo-saka|Bukayo Saka|2001|FWD|1|eng||arsenal:2018-
declan-rice|Declan Rice|1999|MID|1|eng||arsenal:2023-
marcus-rashford|Marcus Rashford|1997|FWD|1|eng||man-utd:2015-
trent-alexander-arnold|Trent Alexander-Arnold|1998|DEF|1|eng|TAA|liverpool:2016-
thibaut-courtois|Thibaut Courtois|1992|GK|1|bel||chelsea:2011-2017,atletico:2011-2013,real-madrid:2018-
joshua-kimmich|Joshua Kimmich|1995|MID|1|ger||bayern:2015-
jamal-musiala|Jamal Musiala|2003|MID|1|ger||bayern:2020-
`;

function csv(s: string | undefined) {
  return s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

export function buildSampleDataset(generatedAt = '2025-01-01T00:00:00.000Z'): Dataset {
  const teams: Team[] = [
    ...CLUBS.map(([id, name, shortName, country, color, aliases]) => ({
      id,
      kind: 'club' as const,
      name,
      shortName,
      country,
      color,
      aliases: csv(aliases),
      source: SOURCE,
      providerIds: {},
    })),
    ...NATIONS.map(([code, name, shortName, color]) => ({
      id: `nt-${code}`,
      kind: 'national' as const,
      name,
      shortName,
      country: name,
      color,
      aliases: [] as string[],
      source: SOURCE,
      providerIds: {},
    })),
  ];
  const affiliations: Affiliation[] = [];
  const players = PLAYERS.trim()
    .split('\n')
    .map((line) => {
      const [id, name, born, pos, tier, nats, aliases, careers] = line.split('|') as [
        string,
        string,
        string,
        'GK' | 'DEF' | 'MID' | 'FWD',
        string,
        string,
        string,
        string,
      ];
      for (const nat of csv(nats)) {
        affiliations.push({
          playerId: id,
          teamId: `nt-${nat}`,
          fromSeason: null,
          toSeason: null,
          precision: 'unknown',
          status: 'confirmed',
          source: SOURCE,
        });
      }
      for (const spell of csv(careers)) {
        const [teamId, range] = spell.split(':') as [string, string];
        const [from, to] = range.split('-');
        affiliations.push({
          playerId: id,
          teamId,
          fromSeason: Number(from),
          toSeason: to ? Number(to) : null,
          precision: 'season',
          status: 'confirmed',
          source: SOURCE,
        });
      }
      return {
        id,
        name,
        aliases: csv(aliases),
        birthYear: Number(born),
        position: pos,
        tier: Number(tier) as 1 | 2 | 3,
        fame: Number(tier) === 1 ? 100 : Number(tier) === 2 ? 50 : 10,
        source: SOURCE,
        providerIds: {},
      };
    });

  return DatasetSchema.parse({
    meta: {
      sourceId: SOURCE,
      label: 'Pitchside sample data',
      kind: 'sample',
      generatedAt,
      license: 'Hand-curated factual sample by the project; no third-party database copied.',
      attribution: 'Pitchside sample dataset (demo only)',
      notes:
        'Not live and not complete. Snapshot as of the 2024-25 season. Careers list only the clubs in the sample club table.',
      currentSeason: SAMPLE_CURRENT_SEASON,
    },
    teams,
    competitions: LEAGUES.map(([id, name, shortName, country, aliases]) => ({
      id,
      kind: 'league' as const,
      name,
      shortName,
      country,
      aliases: csv(aliases),
      source: SOURCE,
      providerIds: {},
    })),
    memberships: MEMBERSHIPS.map(([teamId, competitionId, fromSeason, toSeason]) => ({
      teamId,
      competitionId,
      fromSeason,
      toSeason,
      status: 'confirmed' as const,
      source: SOURCE,
    })),
    players,
    affiliations,
  });
}

export const sampleDataset: Dataset = buildSampleDataset();
