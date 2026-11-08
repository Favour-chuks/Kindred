import { KindredProvider, useKindred } from "./context/KindredContext";
import {BrandHeader} from "@/components/header";
import {ConsentScreen} from "@/components/ConsentScreen";
import {ActivityScreen} from "@/components/ActivityScreen";
import {ResultsScreen} from "@/components/ResultsScreen";


function KindredAppContent() {
  const { screen } = useKindred();
  return (
    <main className="page-shell antialiased"><BrandHeader />
      {screen === "consent" && <ConsentScreen />}
      {screen === "activity" && <ActivityScreen />}
      {screen === "results" && <ResultsScreen />}
    </main>
    );
}

export function App() { return <KindredProvider><KindredAppContent /></KindredProvider>; }
export default App;
