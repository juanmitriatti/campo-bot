import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface MonthlyTrend {
  month: string;
  label: string;
  expenses: number;
  incomes: number;
}

interface ExpenseCategory {
  category: string;
  total: number;
}

interface AnalyticsData {
  monthlyTrend: MonthlyTrend[];
  expenseCategories: ExpenseCategory[];
}

export function useAnalyticsData() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const json = await apiRequest<AnalyticsData>('/analytics');
        setData(json);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return { data, loading, error };
}
