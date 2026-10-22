import unittest
from databento_feed import PairedBars

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.c = PairedBars({'NQ':'NQZ26','ES':'ESZ26'})
        self.b = {'time':60000,'open':100,'high':101,'low':99,'close':100.25,'volume':10}
    def test_pairing_and_duplicate(self):
        self.assertFalse(self.c.add('NQ',self.b,120000))
        self.assertTrue(self.c.add('ES',self.b,120000))
        self.assertFalse(self.c.add('ES',self.b,120000))
        self.assertEqual(len(self.c.frames),1)
        self.assertEqual(self.c.frames[0]['time'],120000)
    def test_no_forward_fill(self):
        self.c.add('NQ',self.b,120000)
        self.c.add('ES',{**self.b,'time':120000},180000)
        self.assertEqual(self.c.frames,[])
    def test_rejects_bad_data(self):
        for b in [{**self.b,'close':100.1},{**self.b,'volume':-1},{**self.b,'high':float('nan')}]:
            with self.assertRaises(ValueError):self.c.add('NQ',b,120000)
        with self.assertRaises(ValueError):self.c.add('NQ',self.b,119999)

if __name__=='__main__':unittest.main()
