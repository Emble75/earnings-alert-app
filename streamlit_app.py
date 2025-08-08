import streamlit as st
import pandas as pd
import datetime
from scraper import fetch_press_releases, contains_earnings
from gpt_analyzer import analyze

st.title("📊 Earnings Alert App")

df = pd.read_csv('earnings_watchlist.csv')
today = pd.Timestamp.today().date()
today_df = df[pd.to_datetime(df['Date']).dt.date == today]

if today_df.empty:
    st.info("Heute sind keine Earnings-Termine geplant.")
else:
    for _, row in today_df.iterrows():
        st.subheader(f"Heute erwartet: {row['Company']} ({row['TimeOfDay']})")
        if st.button(f"Jetzt analysieren ({row['Company']})"):
            content = fetch_press_releases(row['IR_URL'])
            if contains_earnings(content):
                result = analyze(content[:4000])
                st.text_area("🧠 GPT Analyse", result, height=300)
            else:
                st.warning("Noch keine relevanten Quartalsinformationen gefunden.")
