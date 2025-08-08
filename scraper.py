import requests
from bs4 import BeautifulSoup
import datetime
import pandas as pd

WATCHLIST = 'earnings_watchlist.csv'
KEYWORDS = ['Q2', 'Quartal', 'Halbjahr', 'Ergebnisse']

def fetch_press_releases(url):
    try:
        resp = requests.get(url, timeout=10)
        soup = BeautifulSoup(resp.text, 'html.parser')
        return soup.get_text()
    except Exception as e:
        return f"Fehler beim Abrufen: {e}"

def contains_earnings(text):
    return any(kw in text for kw in KEYWORDS)

def check_today():
    df = pd.read_csv(WATCHLIST)
    today = pd.Timestamp.today().date()
    hits = []
    for _, row in df.iterrows():
        if pd.to_datetime(row['Date']).date() == today:
            content = fetch_press_releases(row['IR_URL'])
            if contains_earnings(content):
                hits.append((row['Company'], content))
    return hits

if __name__ == '__main__':
    results = check_today()
    for company, report in results:
        with open(f'{company}_report.txt', 'w', encoding='utf-8') as f:
            f.write(report)
