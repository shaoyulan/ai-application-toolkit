namespace Demo
{
    public class Service
    {
        public int Compute(int x)
        {
            return Helper(x) + 1;
        }

        private int Helper(int x)
        {
            return x * 2;
        }
    }
}
