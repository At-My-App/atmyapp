export interface Joke {
  number: number;
  setup: string;
  punchline: string;
  image?: string;
  publishedAt: string;
}

export const siteSettings = {
  title: "Joke of the Day",
  description: "A tiny static Astro site with an AtMyApp-ready content model.",
};

export const jokes: Joke[] = [
  {
    number: 42,
    setup: "Why did the static site bring a notebook to the API meeting?",
    punchline: "Because it wanted to cache the punchlines before they changed.",
    image: "/joke-card.svg",
    publishedAt: "2026-07-06",
  },
  {
    number: 41,
    setup: "Why was the schema always invited to planning?",
    punchline: "It knew how to structure the conversation.",
    publishedAt: "2026-07-05",
  },
  {
    number: 40,
    setup: "Why did the developer trust the preview build?",
    punchline: "It had already passed the vibe check and the type check.",
    publishedAt: "2026-07-04",
  },
];

export const todaysJoke = jokes[0];
