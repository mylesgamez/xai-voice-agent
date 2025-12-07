import https from 'https';
import log from './logger';

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
const X_API_BASE = 'https://api.x.com';

// WOEID mapping for trends
const WOEID_MAP: Record<string, number> = {
  'US': 23424977,
  'UK': 23424975,
  'CA': 23424775,
  'AU': 23424748,
};

interface XPost {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
  };
}

interface XUser {
  id: string;
  name: string;
  username: string;
}

interface SearchResponse {
  data?: XPost[];
  includes?: { users?: XUser[] };
  meta?: {
    result_count: number;
    next_token?: string;
  };
  errors?: Array<{ message: string }>;
}

interface TrendResponse {
  data?: Array<{ trend_name: string; tweet_count?: number }>;
  errors?: Array<{ message: string }>;
}

// Helper to make authenticated requests
async function xApiRequest<T>(endpoint: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, X_API_BASE);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${X_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          // Log full raw response for debugging
          log.app.debug(`[X-API] Endpoint: ${endpoint}`);
          log.app.debug(`[X-API] Status: ${res.statusCode}`);
          log.app.debug(`[X-API] Response: ${data}`);

          const parsed = JSON.parse(data) as T;
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Search for posts about a specific topic (last 24 hours)
 * Fetches 2 pages (up to 40 posts) for comprehensive coverage
 */
export async function searchNewsTopic(topic: string): Promise<string> {
  const now = new Date();
  const endTime = new Date(now.getTime() - 15 * 1000); // 15 seconds ago (X API requires 10+ seconds)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const baseParams = {
    query: `${topic} lang:en -is:retweet`,
    max_results: '20',
    start_time: yesterday.toISOString(),
    end_time: endTime.toISOString(),
    'tweet.fields': 'text,author_id,created_at,public_metrics',
    'expansions': 'author_id',
    'user.fields': 'name,username',
    'sort_order': 'relevancy',
  };

  try {
    // Fetch page 1
    const params1 = new URLSearchParams(baseParams);
    const response1 = await xApiRequest<SearchResponse>(
      `/2/tweets/search/recent?${params1.toString()}`
    );

    if (response1.errors && response1.errors.length > 0) {
      return JSON.stringify({
        success: false,
        message: response1.errors[0].message,
        posts: []
      });
    }

    if (!response1.data || response1.data.length === 0) {
      return JSON.stringify({
        success: false,
        message: `No recent posts found about "${topic}"`,
        posts: []
      });
    }

    // Collect posts and users from page 1
    let allPosts: XPost[] = [...response1.data];
    const userMap = new Map<string, XUser>();
    response1.includes?.users?.forEach(user => userMap.set(user.id, user));

    // Fetch page 2 if next_token exists
    if (response1.meta?.next_token) {
      const params2 = new URLSearchParams({
        ...baseParams,
        next_token: response1.meta.next_token,
      });

      try {
        const response2 = await xApiRequest<SearchResponse>(
          `/2/tweets/search/recent?${params2.toString()}`
        );

        if (response2.data) {
          allPosts = [...allPosts, ...response2.data];
        }
        response2.includes?.users?.forEach(user => userMap.set(user.id, user));
      } catch (e) {
        // Page 2 failed, continue with page 1 results
        log.app.warn(`[X-API] Page 2 fetch failed, using page 1 only: ${e}`);
      }
    }

    // Format all posts for summarization
    const posts = allPosts.map(post => ({
      text: post.text,
      author: userMap.get(post.author_id || '')?.name || 'Unknown',
      username: userMap.get(post.author_id || '')?.username || '',
      likes: post.public_metrics?.like_count || 0,
      retweets: post.public_metrics?.retweet_count || 0,
    }));

    return JSON.stringify({
      success: true,
      topic,
      post_count: posts.length,
      posts
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      message: `Error searching for "${topic}": ${error}`,
      posts: []
    });
  }
}

/**
 * Get trending topics and top posts for each
 */
export async function getTrendingNews(country: string = 'US'): Promise<string> {
  const woeid = WOEID_MAP[country] || WOEID_MAP['US'];

  try {
    // Step 1: Get trends
    const trendsResponse = await xApiRequest<TrendResponse>(
      `/2/trends/by/woeid/${woeid}?max_trends=10`
    );

    if (trendsResponse.errors && trendsResponse.errors.length > 0) {
      return JSON.stringify({
        success: false,
        message: trendsResponse.errors[0].message,
        trends: []
      });
    }

    if (!trendsResponse.data || trendsResponse.data.length === 0) {
      return JSON.stringify({
        success: false,
        message: `No trends found for ${country}`,
        trends: []
      });
    }

    // Get top 6 trends by tweet volume
    const topTrends = trendsResponse.data
      .sort((a, b) => (b.tweet_count || 0) - (a.tweet_count || 0))
      .slice(0, 6);

    // Step 2: Fetch posts for each trend
    const now = new Date();
    const endTime = new Date(now.getTime() - 15 * 1000); // 15 seconds ago (X API requires 10+ seconds)
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const trendsWithPosts = await Promise.all(
      topTrends.map(async (trend) => {
        const params = new URLSearchParams({
          query: `${trend.trend_name} lang:en -is:retweet`,
          max_results: '10',
          start_time: yesterday.toISOString(),
          end_time: endTime.toISOString(),
          'tweet.fields': 'text,author_id,public_metrics',
          'expansions': 'author_id',
          'user.fields': 'name,username',
          'sort_order': 'relevancy',
        });

        try {
          const searchResponse = await xApiRequest<SearchResponse>(
            `/2/tweets/search/recent?${params.toString()}`
          );

          const userMap = new Map<string, XUser>();
          searchResponse.includes?.users?.forEach(user => userMap.set(user.id, user));

          const posts = (searchResponse.data || []).slice(0, 5).map(post => ({
            text: post.text,
            author: userMap.get(post.author_id || '')?.name || 'Unknown',
            likes: post.public_metrics?.like_count || 0,
          }));

          return {
            trend_name: trend.trend_name,
            tweet_count: trend.tweet_count,
            posts
          };
        } catch {
          return {
            trend_name: trend.trend_name,
            tweet_count: trend.tweet_count,
            posts: []
          };
        }
      })
    );

    return JSON.stringify({
      success: true,
      country,
      trends: trendsWithPosts
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      message: `Error fetching trends: ${error}`,
      trends: []
    });
  }
}

/**
 * Get recent posts from a specific user (last 24 hours)
 */
export async function getUserPosts(username: string): Promise<string> {
  // Step 1: Look up user ID from username
  const cleanUsername = username.replace('@', '').trim();

  try {
    const userResponse = await xApiRequest<{
      data?: { id: string; name: string; username: string };
      errors?: Array<{ message: string }>;
    }>(`/2/users/by/username/${cleanUsername}`);

    if (userResponse.errors && userResponse.errors.length > 0) {
      return JSON.stringify({
        success: false,
        message: userResponse.errors[0].message,
        posts: []
      });
    }

    if (!userResponse.data) {
      return JSON.stringify({
        success: false,
        message: `User "${username}" not found`,
        posts: []
      });
    }

    const userId = userResponse.data.id;
    const userName = userResponse.data.name;

    // Step 2: Get user's recent tweets
    const now = new Date();
    const endTime = new Date(now.getTime() - 15 * 1000); // 15 seconds ago
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      max_results: '10',
      start_time: yesterday.toISOString(),
      end_time: endTime.toISOString(),
      'tweet.fields': 'text,created_at,public_metrics',
      exclude: 'retweets,replies'  // Only original posts
    });

    const tweetsResponse = await xApiRequest<SearchResponse>(
      `/2/users/${userId}/tweets?${params.toString()}`
    );

    if (tweetsResponse.errors && tweetsResponse.errors.length > 0) {
      return JSON.stringify({
        success: false,
        message: tweetsResponse.errors[0].message,
        posts: []
      });
    }

    if (!tweetsResponse.data || tweetsResponse.data.length === 0) {
      return JSON.stringify({
        success: false,
        message: `No recent posts from ${userName} (@${cleanUsername}) in the last 24 hours`,
        posts: []
      });
    }

    const posts = tweetsResponse.data.map(post => ({
      text: post.text,
      created_at: post.created_at,
      likes: post.public_metrics?.like_count || 0,
      retweets: post.public_metrics?.retweet_count || 0,
    }));

    return JSON.stringify({
      success: true,
      user: {
        name: userName,
        username: cleanUsername
      },
      post_count: posts.length,
      posts
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      message: `Error fetching posts from "${username}": ${error}`,
      posts: []
    });
  }
}
