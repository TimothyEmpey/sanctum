import { FuturesPage } from "@/components/futures-pages";
export default async function Page({searchParams}:{searchParams:Promise<{asset?:string}>}) {
 const {asset}=await searchParams;
 return <FuturesPage page="Dashboard" asset={asset}/>;
}
